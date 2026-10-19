'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import MeterQrScanner from '@/components/MeterQrScanner';
import {
  getWorkOrders,
  completeWorkOrder,
  uploadWorkOrderPhoto,
  type WorkOrder,
} from '@/lib/api';

export default function TechnicianPortalPage() {
  const [techId, setTechId] = useState('');
  const [activeTechId, setActiveTechId] = useState('');
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadWorkOrders = useCallback(async (id: string) => {
    if (!id) {
      setWorkOrders([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const orders = await getWorkOrders(id);
      setWorkOrders(Array.isArray(orders) ? orders : []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load work orders.'
      );
      setWorkOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTechId) {
      void loadWorkOrders(activeTechId);
    }
  }, [activeTechId, loadWorkOrders]);

  const handleSelectTechnician = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = techId.trim();
    if (!trimmed) {
      setError('Please enter a technician ID.');
      return;
    }
    setError(null);
    setActiveTechId(trimmed);
  };

  const handleComplete = async (order: WorkOrder) => {
    setCompletingId(order.id);
    setError(null);
    try {
      await completeWorkOrder(order.id, notes[order.id] ?? '');
      setWorkOrders((prev) =>
        prev.map((o) =>
          o.id === order.id ? { ...o, status: 'completed' } : o
        )
      );
      setNotes((prev) => {
        const next = { ...prev };
        delete next[order.id];
        return next;
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to complete work order.'
      );
    } finally {
      setCompletingId(null);
    }
  };

  const handlePhotoSelected = async (
    order: WorkOrder,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingId(order.id);
    setUploadMessage(null);
    setError(null);
    try {
      await uploadWorkOrderPhoto(order.id, file);
      setUploadMessage(`Photo uploaded for work order ${order.id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload photo.');
    } finally {
      setUploadingId(null);
      const input = fileInputRefs.current[order.id];
      if (input) input.value = '';
    }
  };

  const handleMeterRegistered = (meterId: string) => {
    setUploadMessage(`Meter ${meterId} registered.`);
    setShowScanner(false);
  };

  return (
    <main className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-10 bg-blue-700 px-4 py-4 text-white shadow">
        <h1 className="text-xl font-bold">Technician Portal</h1>
        <p className="text-sm text-blue-100">
          Manage your work orders on the go
        </p>
      </header>

      <section className="px-4 py-4">
        <form onSubmit={handleSelectTechnician} className="space-y-3">
          <label
            htmlFor="techId"
            className="block text-sm font-medium text-gray-700"
          >
            Technician ID
          </label>
          <input
            id="techId"
            type="text"
            inputMode="text"
            autoComplete="off"
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
            placeholder="Enter your technician ID"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-blue-700 px-4 py-4 text-base font-semibold text-white shadow active:bg-blue-800 disabled:opacity-50"
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load My Work Orders'}
          </button>
        </form>
      </section>

      <section className="px-4">
        <button
          type="button"
          onClick={() => setShowScanner((s) => !s)}
          className="w-full rounded-lg border border-blue-700 px-4 py-4 text-base font-semibold text-blue-700 shadow-sm active:bg-blue-50"
        >
          {showScanner ? 'Close Meter Scanner' : 'Scan Meter QR Code'}
        </button>
        {showScanner && (
          <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white p-2">
            <MeterQrScanner onRegistered={handleMeterRegistered} />
          </div>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="mx-4 mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {uploadMessage && (
        <div
          role="status"
          className="mx-4 mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700"
        >
          {uploadMessage}
        </div>
      )}

      <section className="mt-4 space-y-4 px-4">
        {loading && (
          <p className="py-8 text-center text-gray-500">Loading work orders…</p>
        )}

        {!loading && activeTechId && workOrders.length === 0 && !error && (
          <p className="py-8 text-center text-gray-500">
            No work orders assigned.
          </p>
        )}

        {!loading &&
          workOrders.map((order) => (
            <article
              key={order.id}
              className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    {order.title ?? `Work Order ${order.id}`}
                  </h2>
                  {order.address && (
                    <p className="text-sm text-gray-600">{order.address}</p>
                  )}
                </div>
                <span
                  className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${
                    order.status === 'completed'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {order.status ?? 'pending'}
                </span>
              </div>

              {order.description && (
                <p className="mt-2 text-sm text-gray-700">
                  {order.description}
                </p>
              )}

              {order.status !== 'completed' && (
                <div className="mt-4 space-y-3">
                  <label
                    htmlFor={`notes-${order.id}`}
                    className="block text-sm font-medium text-gray-700"
                  >
                    Completion notes
                  </label>
                  <textarea
                    id={`notes-${order.id}`}
                    rows={3}
                    value={notes[order.id] ?? ''}
                    onChange={(e) =>
                      setNotes((prev) => ({
                        ...prev,
                        [order.id]: e.target.value,
                      }))
                    }
                    placeholder="Add notes about the work performed"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />

                  <button
                    type="button"
                    onClick={() => void handleComplete(order)}
                    disabled={completingId === order.id}
                    className="w-full rounded-lg bg-green-600 px-4 py-4 text-base font-semibold text-white shadow active:bg-green-700 disabled:opacity-50"
                  >
                    {completingId === order.id
                      ? 'Completing…'
                      : 'Mark Complete'}
                  </button>
                </div>
              )}

              <div className="mt-4">
                <label
                  htmlFor={`photo-${order.id}`}
                  className="block text-sm font-medium text-gray-700"
                >
                  Installation photo
                </label>
                <input
                  id={`photo-${order.id}`}
                  ref={(el) => {
                    fileInputRefs.current[order.id] = el;
                  }}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => void handlePhotoSelected(order, e)}
                  disabled={uploadingId === order.id}
                  className="mt-2 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-700 file:px-4 file:py-3 file:text-base file:font-semibold file:text-white active:file:bg-blue-800"
                />
                {uploadingId === order.id && (
                  <p className="mt-2 text-sm text-gray-500">Uploading…</p>
                )}
              </div>
            </article>
          ))}
      </section>
    </main>
  );
}