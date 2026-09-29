package com.stellarsolargrid.app.widget

import android.content.Context
import org.json.JSONObject

/** Summary returned by GET /api/widgets/summary (#901). */
data class MeterSummary(
    val meterId: String,
    val active: Boolean,
    val balanceXlm: Double,
    val todayUnits: Double,
    val last7DaysUnits: List<Double>,
    val daysRemaining: Double?,
    val updatedAt: String,
) {
    companion object {
        fun fromJson(json: String): MeterSummary? = try {
            val o = JSONObject(json)
            val days = o.getJSONArray("last7DaysUnits")
            MeterSummary(
                meterId = o.getString("meterId"),
                active = o.getBoolean("active"),
                balanceXlm = o.getDouble("balanceXlm"),
                todayUnits = o.getDouble("todayUnits"),
                last7DaysUnits = List(days.length()) { days.getDouble(it) },
                daysRemaining = if (o.isNull("daysRemaining")) null else o.getDouble("daysRemaining"),
                updatedAt = o.getString("updatedAt"),
            )
        } catch (e: Exception) {
            null
        }
    }
}

/**
 * Widget configuration (set by the app via WidgetBridgePlugin) and the last
 * good summary + ETag, so the widget renders instantly from cache and an
 * unchanged refresh costs only a 304.
 */
object WidgetDataStore {
    private const val PREFS = "solargrid_widget"
    private const val KEY_METER = "meterId"
    private const val KEY_API = "apiUrl"
    private const val KEY_SUMMARY = "summary"
    private const val KEY_ETAG = "etag"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun meterId(context: Context): String? = prefs(context).getString(KEY_METER, null)
    fun apiUrl(context: Context): String? = prefs(context).getString(KEY_API, null)
    fun etag(context: Context): String? = prefs(context).getString(KEY_ETAG, null)

    fun summary(context: Context): MeterSummary? =
        prefs(context).getString(KEY_SUMMARY, null)?.let { MeterSummary.fromJson(it) }

    /** Returns true when the configuration changed. */
    fun configure(context: Context, meterId: String, apiUrl: String): Boolean {
        val p = prefs(context)
        val changed = p.getString(KEY_METER, null) != meterId || p.getString(KEY_API, null) != apiUrl
        if (changed) {
            p.edit()
                .putString(KEY_METER, meterId)
                .putString(KEY_API, apiUrl)
                .remove(KEY_SUMMARY)
                .remove(KEY_ETAG)
                .apply()
        }
        return changed
    }

    fun saveSummary(context: Context, json: String, etag: String?) {
        prefs(context).edit().putString(KEY_SUMMARY, json).putString(KEY_ETAG, etag).apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
