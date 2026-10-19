"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useModalA11y } from "@/hooks/useModalA11y";
import { useToast } from "@/components/ToastProvider";
import {
  downloadPaymentReceipt,
  getReceiptImageBlob,
  getReceiptPdfBlob,
  receiptFilenameStem,
} from "@/lib/receipt";
import type { PaymentRecord } from "@/services/paymentService";

interface Props {
  record: PaymentRecord;
  explorerUrl: string;
  /** Matches the compact table-row button vs. the full-width mobile-card button. */
  className?: string;
}

function canShareFiles(files: File[]): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files })
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

/**
 * "Share" control for a payment receipt (Issue #749). Offers, in order of
 * how directly each reaches another person:
 *  - the device's native share sheet (when available), sharing the receipt
 *    PDF or image as a file where the OS supports it
 *  - direct links into WhatsApp / email / SMS with the receipt link prefilled
 *  - copy the receipt link, and a QR code for it
 */
export default function ShareReceiptButton({ record, explorerUrl, className }: Props) {
  const [open, setOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { showToast } = useToast();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const qrPanelRef = useModalA11y<HTMLDivElement>(() => setQrOpen(false));

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const shareText = `Payment receipt — ${record.amountXlm.toFixed(4)} XLM for meter ${record.meterId}`;

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  async function withBusy(action: string, fn: () => Promise<void>) {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await fn();
    } catch (e: any) {
      showToast({ variant: "error", title: "Share failed", description: e?.message ?? "Please try again." });
    } finally {
      setBusyAction(null);
    }
  }

  async function shareNative() {
    await withBusy("native", async () => {
      if (navigator.share) {
        await navigator.share({ title: "SolarGrid Payment Receipt", text: shareText, url: explorerUrl });
      }
      setOpen(false);
    });
  }

  async function shareAsPdf() {
    await withBusy("pdf", async () => {
      const blob = await getReceiptPdfBlob(record, explorerUrl);
      const file = new File([blob], `${receiptFilenameStem(record)}.pdf`, { type: "application/pdf" });
      if (canShareFiles([file])) {
        await navigator.share({ files: [file], title: "SolarGrid Payment Receipt", text: shareText });
      } else {
        await downloadPaymentReceipt(record, explorerUrl);
      }
      setOpen(false);
    });
  }

  async function shareAsImage() {
    await withBusy("image", async () => {
      const blob = await getReceiptImageBlob(record, explorerUrl);
      const file = new File([blob], `${receiptFilenameStem(record)}.png`, { type: "image/png" });
      if (canShareFiles([file])) {
        await navigator.share({ files: [file], title: "SolarGrid Payment Receipt", text: shareText });
      } else {
        downloadBlob(blob, `${receiptFilenameStem(record)}.png`);
      }
      setOpen(false);
    });
  }

  async function copyLink() {
    await withBusy("copy", async () => {
      const ok = await copyText(explorerUrl);
      showToast(
        ok
          ? { variant: "success", title: "Receipt link copied" }
          : { variant: "error", title: "Could not copy link", description: explorerUrl },
      );
      setOpen(false);
    });
  }

  function openExternalShare(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Share receipt for payment on ${new Date(record.date).toLocaleDateString()}`}
        className={
          className ??
          "rounded-lg border border-white/10 px-3 py-1.5 text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition disabled:opacity-50 whitespace-nowrap"
        }
      >
        Share
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 z-40 mt-2 w-56 rounded-xl border border-white/10 bg-solar-accent shadow-2xl overflow-hidden"
        >
          {canNativeShare && (
            <MenuItem onClick={shareNative} busy={busyAction === "native"} label="Share via device…" />
          )}
          <MenuItem onClick={shareAsPdf} busy={busyAction === "pdf"} label="Share as PDF" />
          <MenuItem onClick={shareAsImage} busy={busyAction === "image"} label="Share as image" />
          <MenuItem onClick={copyLink} busy={busyAction === "copy"} label="Copy receipt link" />
          <MenuItem
            onClick={() =>
              openExternalShare(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${explorerUrl}`)}`)
            }
            label="Share via WhatsApp"
          />
          <MenuItem
            onClick={() =>
              openExternalShare(
                `mailto:?subject=${encodeURIComponent("SolarGrid Payment Receipt")}&body=${encodeURIComponent(`${shareText}\n\n${explorerUrl}`)}`,
              )
            }
            label="Share via email"
          />
          <MenuItem
            onClick={() => openExternalShare(`sms:?body=${encodeURIComponent(`${shareText} ${explorerUrl}`)}`)}
            label="Share via SMS"
          />
          <MenuItem
            onClick={() => {
              setQrOpen(true);
              setOpen(false);
            }}
            label="Show QR code"
          />
        </div>
      )}

      {qrOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-qr-title"
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setQrOpen(false)} aria-hidden="true" />
          <div
            ref={qrPanelRef}
            tabIndex={-1}
            className="relative w-full max-w-xs rounded-2xl bg-solar-accent border border-white/10 shadow-2xl p-5 text-center"
          >
            <h2 id="share-qr-title" className="font-bold text-solar-yellow text-sm mb-3">
              Scan to view receipt
            </h2>
            <div className="inline-flex items-center justify-center rounded-lg bg-white p-3">
              <QRCodeCanvas value={explorerUrl} size={176} />
            </div>
            <p className="mt-3 text-xs text-gray-400 break-all">{explorerUrl}</p>
            <button
              onClick={() => setQrOpen(false)}
              className="mt-4 w-full rounded-lg border border-white/10 py-2 text-sm text-gray-300 hover:border-solar-yellow hover:text-solar-yellow transition"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, label, busy }: { onClick: () => void; label: string; busy?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={busy}
      className="block w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-solar-yellow transition disabled:opacity-50"
    >
      {busy ? "Working…" : label}
    </button>
  );
}
