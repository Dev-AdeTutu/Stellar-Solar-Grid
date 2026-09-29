package com.stellarsolargrid.app.widget

import android.content.Context
import android.net.Uri
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Refreshes widget data every 15 minutes (#901).
 *
 * Battery: WorkManager batches this with other jobs and honours Doze; the
 * job only runs with a network connection and when the battery is not low,
 * and the request uses If-None-Match so unchanged data is a bodiless 304.
 * The widget's own updatePeriodMillis is 0 — this worker is the only timer.
 */
class WidgetUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val meterId = WidgetDataStore.meterId(ctx) ?: return Result.success()
        val apiUrl = WidgetDataStore.apiUrl(ctx) ?: return Result.success()

        withContext(Dispatchers.IO) {
            val url = Uri.parse("$apiUrl/api/widgets/summary").buildUpon()
                .appendQueryParameter("meterId", meterId)
                .build()
                .toString()
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 10_000
                    readTimeout = 10_000
                    useCaches = false
                    if (WidgetDataStore.summary(ctx) != null) {
                        WidgetDataStore.etag(ctx)?.let { setRequestProperty("If-None-Match", it) }
                    }
                }
                if (conn.responseCode == HttpURLConnection.HTTP_OK) {
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    if (MeterSummary.fromJson(body) != null) {
                        WidgetDataStore.saveSummary(ctx, body, conn.getHeaderField("ETag"))
                    }
                }
                // 304 or an error: keep showing the cached summary.
            } catch (_: Exception) {
                // Network failure — the next periodic run will try again; no retry
                // back-off here so a flaky connection never keeps the radio awake.
            } finally {
                conn?.disconnect()
            }
        }

        SolarGridWidgetProvider.updateAll(ctx)
        return Result.success()
    }

    companion object {
        private const val PERIODIC = "solargrid-widget-refresh"
        private const val IMMEDIATE = "solargrid-widget-refresh-now"

        private val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

        /** 15 minutes is WorkManager's minimum periodic interval. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<WidgetUpdateWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun refreshNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<WidgetUpdateWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.REPLACE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }
    }
}
