// SolarGrid home-screen widget (#901) — small, medium and large sizes.
//
// Refresh policy: one network request every 5 minutes (`.after(+5m)`),
// with ETag revalidation and Low-Data-Mode respect in SummaryFetcher. WidgetKit
// may coalesce refreshes further to save battery; the app also triggers an
// immediate reload when the user switches meters.
//
// Tapping the widget opens the app on the meter dashboard
// (solargrid://meter/<id>); the large widget's "Top up" button deep links to
// the pay screen (solargrid://pay?meter=<id>).

import SwiftUI
import WidgetKit

struct MeterEntry: TimelineEntry {
    let date: Date
    let summary: MeterSummary?
    let configured: Bool
}

struct Provider: TimelineProvider {
    static let refreshInterval: TimeInterval = 5 * 60

    func placeholder(in context: Context) -> MeterEntry {
        MeterEntry(date: Date(), summary: .placeholder, configured: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (MeterEntry) -> Void) {
        // Snapshots must be fast — use the cache (or sample data in the gallery).
        if context.isPreview {
            completion(placeholder(in: context))
        } else {
            completion(MeterEntry(date: Date(), summary: WidgetStore.cachedSummary, configured: WidgetStore.meterId != nil))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MeterEntry>) -> Void) {
        Task {
            let summary = await SummaryFetcher.fetch()
            let entry = MeterEntry(date: Date(), summary: summary, configured: WidgetStore.meterId != nil)
            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - Formatting

private func xlm(_ value: Double) -> String {
    value >= 100 ? String(format: "%.0f", value) : String(format: "%.2f", value)
}

private func daysLeftText(_ days: Double?) -> String {
    guard let days else { return "—" }
    if days < 1 { return "< 1 day left" }
    return String(format: "%.0f days left", days.rounded(.down))
}

private let brand = Color(red: 0.96, green: 0.70, blue: 0.0)

// MARK: - Views

struct StatusDot: View {
    let active: Bool
    var body: some View {
        Circle()
            .fill(active ? Color.green : Color.red)
            .frame(width: 8, height: 8)
            .accessibilityLabel(active ? "Active" : "Inactive")
    }
}

struct UsageBars: View {
    let values: [Double]
    var body: some View {
        let maxValue = max(values.max() ?? 1, 0.0001)
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                RoundedRectangle(cornerRadius: 2)
                    .fill(index == values.count - 1 ? brand : brand.opacity(0.45))
                    .frame(height: max(2, CGFloat(value / maxValue) * 44))
            }
        }
        .frame(height: 44, alignment: .bottom)
        .accessibilityElement()
        .accessibilityLabel("Daily usage for the last 7 days")
    }
}

struct NotConfiguredView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SolarGrid").font(.headline).foregroundStyle(brand)
            Text("Open the app and choose a meter to see it here.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct SmallView: View {
    let s: MeterSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(s.meterId).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                StatusDot(active: s.active)
            }
            Spacer(minLength: 0)
            Text(xlm(s.balanceXlm)).font(.system(size: 30, weight: .bold, design: .rounded)).minimumScaleFactor(0.6)
            Text("XLM balance").font(.caption2).foregroundStyle(.secondary)
            Text(daysLeftText(s.daysRemaining)).font(.caption).foregroundStyle(brand)
        }
    }
}

struct MediumView: View {
    let s: MeterSummary
    var body: some View {
        HStack(spacing: 16) {
            SmallView(s: s)
            VStack(alignment: .leading, spacing: 6) {
                Text("Today").font(.caption2).foregroundStyle(.secondary)
                Text(String(format: "%.1f units", s.todayUnits)).font(.headline)
                UsageBars(values: s.last7DaysUnits)
            }
        }
    }
}

struct LargeView: View {
    let s: MeterSummary
    private let dayLabels: [String] = {
        let f = DateFormatter()
        f.dateFormat = "EEEEE"
        return (0..<7).reversed().map { f.string(from: Date().addingTimeInterval(-Double($0) * 86_400)) }
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("SolarGrid").font(.headline).foregroundStyle(brand)
                Spacer()
                StatusDot(active: s.active)
                Text(s.active ? "Active" : "Inactive").font(.caption)
            }
            Text(s.meterId).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline) {
                Text(xlm(s.balanceXlm)).font(.system(size: 40, weight: .bold, design: .rounded))
                Text("XLM").font(.headline).foregroundStyle(.secondary)
                Spacer()
                Text(daysLeftText(s.daysRemaining)).font(.subheadline).foregroundStyle(brand)
            }
            Divider()
            Text(String(format: "Today: %.1f units", s.todayUnits)).font(.subheadline)
            UsageBars(values: s.last7DaysUnits)
            HStack {
                ForEach(dayLabels.indices, id: \.self) { i in
                    Text(dayLabels[i]).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            if let price = s.priceXlmPerKwh {
                let hit = (s.alerts ?? []).contains { $0.triggered }
                Text(String(format: "Price: %.3f XLM/kWh", price) + (hit ? " 🔔" : ""))
                    .font(.caption).foregroundStyle(hit ? brand : .secondary)
            }
            ForEach((s.recentTransactions ?? []).prefix(3), id: \.timestamp) { t in
                Text("\(t.type == "topup" ? "+" : "−")\(xlm(t.amount)) XLM · \(t.type == "topup" ? "Top up" : "Usage")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            HStack {
                if let updated = s.updatedDate {
                    Text("Updated \(updated, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                ForEach(["buy", "sell"], id: \.self) { side in
                    Link(destination: URL(string: "solargrid://trade?meter=\(s.meterId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s.meterId)&side=\(side)")!) {
                        Text(side == "buy" ? "Buy" : "Sell")
                            .font(.caption.bold())
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(brand, in: Capsule())
                            .foregroundStyle(.black)
                    }
                }
            }
        }
    }
}

struct SolarGridWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MeterEntry

    var body: some View {
        Group {
            if let s = entry.summary {
                switch family {
                case .systemSmall: SmallView(s: s)
                case .systemMedium: MediumView(s: s)
                default: LargeView(s: s)
                }
            } else {
                NotConfiguredView()
            }
        }
        .widgetURL(deepLink)
        .widgetBackground()
    }

    private var deepLink: URL {
        guard let id = entry.summary?.meterId ?? WidgetStore.meterId,
              let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { return URL(string: "solargrid://dashboard")! }
        return URL(string: "solargrid://meter/\(encoded)")!
    }
}

private extension View {
    /// iOS 17 requires containerBackground; earlier versions use padding + background.
    @ViewBuilder
    func widgetBackground() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { Color(.systemBackground) }
        } else {
            padding().background(Color(.systemBackground))
        }
    }
}

@main
struct SolarGridWidget: Widget {
    let kind = "SolarGridWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            SolarGridWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("SolarGrid Meter")
        .description("Balance, days remaining and recent usage for your meter.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
