"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, QrCodeIcon, XIcon } from "lucide-react";
import QRCode from "qrcode";

const LATEST_DOWNLOAD_URL = "https://github.com/understudylabs/understudy-agent-tools/releases/latest";

export function DownloadQrButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, LATEST_DOWNLOAD_URL, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 7,
      color: {
        dark: "#111214",
        light: "#f7f5ef",
      },
    }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1300);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(LATEST_DOWNLOAD_URL);
    setCopied(true);
  };

  return (
    <>
      <button
        type="button"
        className="titlebar-qr"
        aria-label="Show download QR code"
        title="Download QR code"
        onClick={() => setOpen(true)}
      >
        <QrCodeIcon aria-hidden="true" size={15} strokeWidth={2} />
      </button>
      {open && (
        <div className="qr-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="qr-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-qr-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="qr-close" aria-label="Close" onClick={() => setOpen(false)}>
              <XIcon aria-hidden="true" size={16} />
            </button>
            <div>
              <h2 id="download-qr-title">Download Understudy</h2>
              <p>Scan to open the latest desktop binary release.</p>
            </div>
            <div className="qr-code-frame">
              <canvas ref={canvasRef} width={256} height={256} />
            </div>
            <div className="qr-url">{LATEST_DOWNLOAD_URL}</div>
            <div className="qr-actions">
              <button type="button" className="btn" onClick={copyLink}>
                {copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" className="btn primary" onClick={() => window.open(LATEST_DOWNLOAD_URL, "_blank")}>
                <ExternalLinkIcon aria-hidden="true" size={14} />
                Open
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
