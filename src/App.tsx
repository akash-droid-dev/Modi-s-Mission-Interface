import { useCallback, useEffect, useRef, useState } from "react";

const MAX_DURATION = 90;
const BASE = import.meta.env.BASE_URL;

type State = "idle" | "recording" | "processing" | "success" | "error";

function fmt(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── IndexedDB: persist recordings so Admin app can read them ──
const DB_NAME = "modis_mission_db";
const STORE = "recordings";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function saveToDB(rec: {
  id: string; created_at: string; duration: number;
  size: number; platform: string; public_url: string; blob: Blob; blob_data?: string;
}) {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const elapsedRef = useRef(0);

  const [state, setState] = useState<State>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [granted, setGranted] = useState(false);
  const [denied, setDenied] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");

  // ── Permissions ─────────────────────────────────────────
  const requestPerms = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: true,
      });
      streamRef.current = stream;
      setGranted(true);
      setDenied(false);
    } catch {
      setDenied(true);
    }
  }, []);

  // Attach stream to video once element is mounted (video only renders when granted)
  useEffect(() => {
    if (granted && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [granted]);

  useEffect(() => {
    requestPerms();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [requestPerms]);

  // ── Auto-stop ───────────────────────────────────────────
  useEffect(() => {
    if (state === "recording" && elapsed >= MAX_DURATION) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, state]);

  // ── Start ───────────────────────────────────────────────
  const start = useCallback(() => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    elapsedRef.current = 0;
    setElapsed(0);
    setErrMsg("");
    setDownloadUrl("");

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";

    const mr = new MediaRecorder(streamRef.current, { mimeType: mime });
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      setState("processing");
      const blob = new Blob(chunksRef.current, { type: mime });
      handleDone(blob);
    };
    mr.start(1000);
    recorderRef.current = mr;
    setState("recording");

    timerRef.current = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
  }, []);

  // ── Stop ────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  // ── Handle finished recording ───────────────────────────
  const handleDone = async (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);

    // Save to IndexedDB (blob + base64 fallback for Admin playback)
    try {
      const blobData = await blobToBase64(blob);
      await saveToDB({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        duration: elapsedRef.current,
        size: blob.size,
        platform: "web",
        public_url: "",
        blob,
        blob_data: blobData,
      });
    } catch (e) {
      console.warn("Could not save to IndexedDB:", e);
    }

    setState("success");
  };

  // ── Reset ───────────────────────────────────────────────
  const reset = () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setState("idle");
    setElapsed(0);
    elapsedRef.current = 0;
    setErrMsg("");
    setDownloadUrl("");
  };

  const toggle = () => {
    if (state === "idle") start();
    else if (state === "recording") stop();
  };

  // ── Permission screen ──────────────────────────────────
  if (!granted) {
    return (
      <main className="page">
        <div className="cover-wrap">
          <img src={`${BASE}cover.png`} alt="Modi's Mission" />
        </div>
        <div className="perm">
          <h2>Camera &amp; Microphone Access</h2>
          <p>
            {denied
              ? "Permission denied. Please allow camera & microphone in your browser settings, then try again."
              : "We need your camera and microphone to record your vision."}
          </p>
          <button className="btn" onClick={requestPerms}>
            {denied ? "Retry Permission" : "Grant Access"}
          </button>
        </div>
      </main>
    );
  }

  // ── Main UI ────────────────────────────────────────────
  return (
    <main className="page">
      {/* Cover Image */}
      <div className="cover-wrap">
        <img src={`${BASE}cover.png`} alt="Modi's Mission" />
      </div>

      {/* Camera Preview */}
      <div className="preview">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="headline"><h1>Modi's Mission</h1></div>
        {(state === "recording" || elapsed > 0) && (
          <div className={`timer ${state === "recording" ? "on" : ""}`}>
            {fmt(elapsed)} / {fmt(MAX_DURATION)}
          </div>
        )}
        <div className="rec-wrap">
          <button
            className={`rec-btn ${state === "recording" ? "on" : ""}`}
            onClick={toggle}
            disabled={state !== "idle" && state !== "recording"}
            aria-label={state === "recording" ? "Stop recording" : "Start recording"}
          >
            <span className="dot" />
          </button>
        </div>
      </div>

      {/* Status */}
      {state === "idle" && (
        <p className="note">
          Record your <strong>Vision for Modi's Mission</strong>.<br />
          <span className="sub">Max {MAX_DURATION}s · Press the red button to begin</span>
        </p>
      )}

      {state === "recording" && (
        <p className="note" style={{ color: "var(--rec)" }}>
          Recording… Press stop when you're done.
        </p>
      )}

      {state === "processing" && (
        <div className="badge processing"><span className="spinner" /> Preparing video…</div>
      )}

      {state === "success" && (
        <>
          <div className="badge success">✓ Your vision has been recorded!</div>
          {downloadUrl && (
            <a className="download-link" href={downloadUrl} download={`modis-mission-${Date.now()}.webm`}>
              ⬇ Download Your Recording
            </a>
          )}
          <button className="btn" onClick={reset}>Record Another</button>
        </>
      )}

      {state === "error" && (
        <>
          <div className="badge error">Error: {errMsg || "Something went wrong."}</div>
          <button className="btn" onClick={reset}>Try Again</button>
        </>
      )}

      <div className="footer">Modi's Mission © 2026</div>
    </main>
  );
}
