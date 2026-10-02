// Shared data layer for the SolarGrid home-screen widget (#901).
//
// The app writes the selected meter and API base URL into the shared App
// Group (see WidgetBridgePlugin.swift); the widget extension reads them,
// fetches /api/widgets/summary and caches the last good response + ETag so
// an unchanged refresh is a cheap 304 and the widget never shows blank.

import Foundation

struct PriceAlert: Codable, Equatable {
    let id: String
    let direction: String
    let price: Double
    let triggered: Bool
}

struct WalletTransaction: Codable, Equatable {
    let type: String
    let amount: Double
    let timestamp: String
}

struct MeterSummary: Codable, Equatable {
    let meterId: String
    let active: Bool
    let balanceXlm: Double
    let todayUnits: Double
    let last7DaysUnits: [Double]
    let daysRemaining: Double?
    let priceXlmPerKwh: Double?
    let alerts: [PriceAlert]?
    let recentTransactions: [WalletTransaction]?
    let updatedAt: String

    var updatedDate: Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: updatedAt)
    }

    static let placeholder = MeterSummary(
        meterId: "METER1",
        active: true,
        balanceXlm: 42.5,
        todayUnits: 3.2,
        last7DaysUnits: [4.1, 3.9, 5.0, 4.4, 3.8, 4.0, 3.2],
        daysRemaining: 9.5,
        priceXlmPerKwh: 0.5,
        alerts: [],
        recentTransactions: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
    )
}

enum WidgetStore {
    /// Must match the App Group enabled on both the app and widget targets.
    static let appGroup = "group.com.stellarsolargrid.app"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    private enum Key {
        static let meterId = "widget.meterId"
        static let apiUrl = "widget.apiUrl"
        static let summary = "widget.summary"
        static let etag = "widget.etag"
    }

    static var meterId: String? { defaults?.string(forKey: Key.meterId) }
    static var apiUrl: String? { defaults?.string(forKey: Key.apiUrl) }
    static var etag: String? { defaults?.string(forKey: Key.etag) }

    static var cachedSummary: MeterSummary? {
        guard let data = defaults?.data(forKey: Key.summary) else { return nil }
        return try? JSONDecoder().decode(MeterSummary.self, from: data)
    }

    /// Returns true when the configuration actually changed.
    @discardableResult
    static func configure(meterId: String, apiUrl: String) -> Bool {
        guard let d = defaults else { return false }
        let changed = d.string(forKey: Key.meterId) != meterId || d.string(forKey: Key.apiUrl) != apiUrl
        if changed {
            d.set(meterId, forKey: Key.meterId)
            d.set(apiUrl, forKey: Key.apiUrl)
            d.removeObject(forKey: Key.summary)
            d.removeObject(forKey: Key.etag)
        }
        return changed
    }

    static func clear() {
        [Key.meterId, Key.apiUrl, Key.summary, Key.etag].forEach { defaults?.removeObject(forKey: $0) }
    }

    static func save(summary data: Data, etag: String?) {
        defaults?.set(data, forKey: Key.summary)
        defaults?.set(etag, forKey: Key.etag)
    }
}

enum SummaryFetcher {
    /// Ephemeral session that respects Low Data Mode, so background widget
    /// refreshes never burn a constrained connection.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.allowsConstrainedNetworkAccess = false
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    /// Fetch the latest summary, falling back to the cached value on 304 or any error.
    static func fetch() async -> MeterSummary? {
        guard let meterId = WidgetStore.meterId,
              let base = WidgetStore.apiUrl,
              var components = URLComponents(string: base + "/api/widgets/summary")
        else { return nil }
        components.queryItems = [URLQueryItem(name: "meterId", value: meterId)]
        guard let url = components.url else { return WidgetStore.cachedSummary }

        var request = URLRequest(url: url)
        if let etag = WidgetStore.etag, WidgetStore.cachedSummary != nil {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return WidgetStore.cachedSummary }
            if http.statusCode == 304 { return WidgetStore.cachedSummary }
            guard http.statusCode == 200 else { return WidgetStore.cachedSummary }
            let summary = try JSONDecoder().decode(MeterSummary.self, from: data)
            WidgetStore.save(summary: data, etag: http.value(forHTTPHeaderField: "ETag"))
            return summary
        } catch {
            return WidgetStore.cachedSummary
        }
    }
}
