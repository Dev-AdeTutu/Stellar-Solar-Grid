package com.stellarsolargrid.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import com.stellarsolargrid.app.R
import java.util.Locale

/**
 * SolarGrid home-screen widget (#901): small, medium and large layouts.
 *
 * Rendering never touches the network — it reads the cached summary written
 * by WidgetUpdateWorker, so onUpdate/resize are cheap.
 */
class SolarGridWidgetProvider : AppWidgetProvider() {

    override fun onEnabled(context: Context) {
        WidgetUpdateWorker.schedule(context)
        WidgetUpdateWorker.refreshNow(context)
    }

    override fun onDisabled(context: Context) {
        WidgetUpdateWorker.cancel(context)
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WidgetUpdateWorker.schedule(context) // idempotent (KEEP) — survives app updates / reboots
        ids.forEach { render(context, manager, it) }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        render(context, manager, id)
    }

    companion object {
        private const val BRAND = 0xFFF5B300.toInt()

        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, SolarGridWidgetProvider::class.java))
            ids.forEach { render(context, manager, it) }
        }

        private fun render(context: Context, manager: AppWidgetManager, id: Int) {
            val summary = WidgetDataStore.summary(context)
            val views = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Let the launcher pick the best layout for the current size.
                RemoteViews(
                    mapOf(
                        SizeF(110f, 110f) to build(context, R.layout.widget_small, summary),
                        SizeF(250f, 110f) to build(context, R.layout.widget_medium, summary),
                        SizeF(250f, 250f) to build(context, R.layout.widget_large, summary),
                    ),
                )
            } else {
                val options = manager.getAppWidgetOptions(id)
                val w = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                val h = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
                val layout = when {
                    w >= 250 && h >= 250 -> R.layout.widget_large
                    w >= 250 -> R.layout.widget_medium
                    else -> R.layout.widget_small
                }
                build(context, layout, summary)
            }
            manager.updateAppWidget(id, views)
        }

        private fun build(context: Context, layout: Int, s: MeterSummary?): RemoteViews {
            val views = RemoteViews(context.packageName, layout)
            val meterId = s?.meterId ?: WidgetDataStore.meterId(context)
            views.setOnClickPendingIntent(
                R.id.widget_root,
                deepLink(context, if (meterId != null) "solargrid://meter/${Uri.encode(meterId)}" else "solargrid://dashboard", 0),
            )

            if (s == null) {
                views.setViewVisibility(R.id.widget_content, View.GONE)
                views.setViewVisibility(R.id.widget_empty, View.VISIBLE)
                return views
            }
            views.setViewVisibility(R.id.widget_content, View.VISIBLE)
            views.setViewVisibility(R.id.widget_empty, View.GONE)

            views.setTextViewText(R.id.widget_meter, s.meterId)
            views.setTextViewText(R.id.widget_balance, formatXlm(s.balanceXlm))
            views.setTextViewText(R.id.widget_days, daysLeft(context, s.daysRemaining))
            views.setInt(R.id.widget_status, "setColorFilter", if (s.active) Color.parseColor("#22C55E") else Color.parseColor("#EF4444"))
            views.setContentDescription(
                R.id.widget_status,
                context.getString(if (s.active) R.string.widget_active else R.string.widget_inactive),
            )

            if (layout != R.layout.widget_small) {
                views.setTextViewText(R.id.widget_today, context.getString(R.string.widget_today_units, s.todayUnits))
                views.setImageViewBitmap(R.id.widget_chart, usageChart(s.last7DaysUnits))
            }
            if (layout == R.layout.widget_large) {
                val meter = Uri.encode(s.meterId)
                views.setOnClickPendingIntent(R.id.widget_topup, deepLink(context, "solargrid://trade?meter=$meter&side=buy", 1))
                views.setOnClickPendingIntent(R.id.widget_sell, deepLink(context, "solargrid://trade?meter=$meter&side=sell", 2))
                views.setTextViewText(
                    R.id.widget_price,
                    s.priceXlmPerKwh?.let { String.format(Locale.US, "%.3f XLM/kWh", it) + if (s.alertTriggered) " 🔔" else "" } ?: "",
                )
                views.setTextViewText(R.id.widget_transactions, s.transactions.joinToString("\n"))
            }
            return views
        }

        private fun deepLink(context: Context, uri: String, requestCode: Int): PendingIntent {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun formatXlm(v: Double) =
            if (v >= 100) String.format(Locale.getDefault(), "%.0f", v) else String.format(Locale.getDefault(), "%.2f", v)

        private fun daysLeft(context: Context, days: Double?): String = when {
            days == null -> "—"
            days < 1 -> context.getString(R.string.widget_less_than_day)
            else -> context.resources.getQuantityString(R.plurals.widget_days_left, days.toInt(), days.toInt())
        }

        /** Small 7-bar chart, today highlighted. Kept tiny to stay well under the RemoteViews bitmap budget. */
        private fun usageChart(values: List<Double>): Bitmap {
            val width = 280
            val height = 80
            val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            if (values.isEmpty()) return bmp
            val canvas = Canvas(bmp)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            val max = values.maxOrNull()?.takeIf { it > 0 } ?: 1.0
            val gap = 8f
            val barWidth = (width - gap * (values.size - 1)) / values.size
            values.forEachIndexed { i, v ->
                val barHeight = maxOf(3f, (v / max * height).toFloat())
                val left = i * (barWidth + gap)
                paint.color = if (i == values.lastIndex) BRAND else (BRAND and 0x00FFFFFF) or (0x73 shl 24)
                canvas.drawRoundRect(RectF(left, height - barHeight, left + barWidth, height.toFloat()), 4f, 4f, paint)
            }
            return bmp
        }
    }
}
