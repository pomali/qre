import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const SUPPORTED_FORMATS = [
  'qr_code',
  'aztec',
  'data_matrix',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_39',
  'code_93',
  'code_128',
  'itf',
  'codabar',
  'pdf417',
]

const LABELS = {
  qr_code: 'QR Code',
  aztec: 'Aztec',
  data_matrix: 'Data Matrix',
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_39: 'Code 39',
  code_93: 'Code 93',
  code_128: 'Code 128',
  itf: 'ITF',
  codabar: 'Codabar',
  pdf417: 'PDF417',
  unknown: 'Unknown',
}

const formatLabel = (format = 'unknown') => LABELS[format] || format

const getRelativeTime = (start, detectedAt) => {
  const delta = Math.max(0, Math.floor((detectedAt - start) / 1000))
  const minutes = Math.floor(delta / 60)
  const seconds = delta % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const isValidUrl = (value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function App() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const detectorRef = useRef(null)
  const detectCodesRef = useRef(async () => {})
  const rafRef = useRef(null)
  const scanningRef = useRef(false)
  const seenValuesRef = useRef(new Set())
  const toastTimerRef = useRef(null)
  const hasSuccessfulScanRef = useRef(false)
  const lowLightTimerRef = useRef(null)
  const pinchStateRef = useRef({ distance: null, zoom: 1 })

  const [permission, setPermission] = useState('prompt')
  const [error, setError] = useState('')
  const [codes, setCodes] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedCode, setSelectedCode] = useState(null)
  const [viewerCode, setViewerCode] = useState(null)
  const [toast, setToast] = useState('')
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: 0.1 })
  const [zoom, setZoom] = useState(1)
  const [sessionStart, setSessionStart] = useState(() => Date.now())
  const [showTorchHint, setShowTorchHint] = useState(false)
  const [focusMessage, setFocusMessage] = useState('')

  const canUseScanner = typeof window !== 'undefined' && 'BarcodeDetector' in window

  const stopScanner = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (lowLightTimerRef.current) {
      clearTimeout(lowLightTimerRef.current)
      lowLightTimerRef.current = null
    }
    scanningRef.current = false
    setTorchOn(false)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    trackRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const showToast = useCallback((message) => {
    setToast(message)
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 1500)
  }, [])

  const triggerFeedback = useCallback(() => {
    if ('vibrate' in navigator) {
      navigator.vibrate(20)
    }
    try {
      const context = new window.AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gain.gain.value = 0.02
      oscillator.start()
      oscillator.stop(context.currentTime + 0.08)
      oscillator.onended = () => {
        context.close().catch(() => {})
      }
    } catch {
      // Ignore playback errors and continue scanning.
    }
  }, [])

  const applyZoom = useCallback(
    async (nextZoom) => {
      if (!trackRef.current) return
      const clamped = clamp(nextZoom, zoomRange.min, zoomRange.max)
      try {
        await trackRef.current.applyConstraints({ advanced: [{ zoom: clamped }] })
        setZoom(clamped)
      } catch {
        setFocusMessage('Zoom is not supported on this camera.')
      }
    },
    [zoomRange.max, zoomRange.min],
  )

  useEffect(() => {
    detectCodesRef.current = async () => {
      if (!videoRef.current || !detectorRef.current || scanningRef.current) return

      scanningRef.current = true
      try {
        const detected = await detectorRef.current.detect(videoRef.current)
        for (const code of detected) {
          if (!code.rawValue || seenValuesRef.current.has(code.rawValue)) {
            continue
          }

          const entry = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            value: code.rawValue,
            format: code.format || 'unknown',
            detectedAt: Date.now(),
          }
          seenValuesRef.current.add(entry.value)
          hasSuccessfulScanRef.current = true
          setShowTorchHint(false)
          setCodes((current) => [entry, ...current])
          setSelectedCode(entry)
          triggerFeedback()
          break
        }
      } catch {
        setError('Scanning failed on this device.')
      } finally {
        scanningRef.current = false
        rafRef.current = requestAnimationFrame(() => {
          void detectCodesRef.current()
        })
      }
    }
  }, [triggerFeedback])

  const startScanner = useCallback(async () => {
    if (!canUseScanner) {
      setError('Barcode scanning is not supported by this browser.')
      return
    }

    stopScanner()
    setError('')

    try {
      const detector = new window.BarcodeDetector({ formats: SUPPORTED_FORMATS })
      detectorRef.current = detector

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })

      streamRef.current = stream
      const [videoTrack] = stream.getVideoTracks()

      if (!videoTrack) {
        setError('No camera is available on this device.')
        stopScanner()
        return
      }

      const capabilities = videoTrack.getCapabilities?.() || {}
      const supportsTorch = Boolean(capabilities.torch)
      trackRef.current = videoTrack
      setTorchSupported(supportsTorch)

      if (capabilities.zoom) {
        const nextRange = {
          min: capabilities.zoom.min,
          max: capabilities.zoom.max,
          step: capabilities.zoom.step || 0.1,
        }
        setZoomRange(nextRange)
        setZoom(nextRange.min)
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      setPermission('granted')

      if (supportsTorch && !hasSuccessfulScanRef.current) {
        lowLightTimerRef.current = setTimeout(() => {
          if (!hasSuccessfulScanRef.current) {
            setShowTorchHint(true)
          }
        }, 10000)
      }

      rafRef.current = requestAnimationFrame(() => {
        void detectCodesRef.current()
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermission('denied')
        setError('Camera access is required to scan codes.')
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setError('No camera is available on this device.')
      } else {
        setError('Unable to start the camera scanner.')
      }
    }
  }, [canUseScanner, stopScanner])

  useEffect(() => {
    const bootstrap = setTimeout(() => {
      void startScanner()
    }, 0)

    return () => {
      clearTimeout(bootstrap)
      stopScanner()
      window.clearTimeout(toastTimerRef.current)
    }
  }, [startScanner, stopScanner])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopScanner()
        return
      }
      void startScanner()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [startScanner, stopScanner])

  const toggleTorch = async () => {
    if (!trackRef.current || !torchSupported) {
      return
    }

    const nextState = !torchOn
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: nextState }] })
      setTorchOn(nextState)
      setShowTorchHint(false)
    } catch {
      setFocusMessage('Torch is not supported on this camera.')
    }
  }

  const onTapToFocus = async (event) => {
    if (!trackRef.current) return

    const capabilities = trackRef.current.getCapabilities?.() || {}
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height

    if (!capabilities.pointsOfInterest) {
      setFocusMessage('Tap-to-focus is not available on this camera.')
      return
    }

    try {
      await trackRef.current.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }],
      })
      setFocusMessage('Focus updated.')
    } catch {
      setFocusMessage('Tap-to-focus is not available on this camera.')
    }
  }

  const onTouchMove = (event) => {
    if (event.touches.length !== 2 || zoomRange.max <= zoomRange.min) {
      pinchStateRef.current.distance = null
      return
    }

    const [touchA, touchB] = event.touches
    const distance = Math.hypot(
      touchA.clientX - touchB.clientX,
      touchA.clientY - touchB.clientY,
    )

    if (!pinchStateRef.current.distance) {
      pinchStateRef.current.distance = distance
      pinchStateRef.current.zoom = zoom
      return
    }

    const delta = distance / pinchStateRef.current.distance
    const nextZoom = pinchStateRef.current.zoom * delta
    void applyZoom(nextZoom)
  }

  const resetSession = () => {
    if (!window.confirm('Clear all scanned codes from this session?')) {
      return
    }
    setCodes([])
    seenValuesRef.current = new Set()
    setSessionStart(Date.now())
    hasSuccessfulScanRef.current = false
    setShowTorchHint(false)
  }

  const openUrl = () => {
    if (!selectedCode || !isValidUrl(selectedCode.value)) {
      return
    }
    window.open(selectedCode.value, '_blank', 'noopener,noreferrer')
  }

  const shareCode = async () => {
    if (!selectedCode) return

    try {
      if (navigator.share) {
        await navigator.share({ text: selectedCode.value })
      } else {
        await navigator.clipboard.writeText(selectedCode.value)
        showToast('Copied to clipboard for sharing.')
      }
    } catch {
      showToast('Unable to share this code.')
    }
  }

  const copyCode = async () => {
    if (!selectedCode) return
    try {
      await navigator.clipboard.writeText(selectedCode.value)
      showToast('Copied')
    } catch {
      showToast('Copy failed')
    }
  }

  return (
    <main className="scanner-page">
      <header className="top-bar">
        <h1>QRe</h1>
        <div className="top-actions">
          <button type="button" onClick={() => setHistoryOpen((open) => !open)}>
            {historyOpen ? 'Hide list' : 'Session list'}
          </button>
          <button type="button" onClick={toggleTorch} disabled={!torchSupported}>
            {torchOn ? 'Torch on' : 'Torch off'}
          </button>
        </div>
      </header>

      <section
        className="viewfinder"
        onClick={onTapToFocus}
        onTouchMove={onTouchMove}
        onTouchEnd={() => {
          pinchStateRef.current.distance = null
        }}
      >
        <video ref={videoRef} muted playsInline aria-label="Camera viewfinder" />
        <div className="reticle" aria-hidden="true" />

        {permission === 'denied' && (
          <div className="overlay-card">
            <h2>Camera permission needed</h2>
            <p>Allow camera access in your browser settings to scan QR and barcodes.</p>
            <button type="button" onClick={startScanner}>
              Retry camera access
            </button>
          </div>
        )}

        {error && permission !== 'denied' && (
          <div className="overlay-card">
            <h2>Scanner unavailable</h2>
            <p>{error}</p>
            <button type="button" onClick={startScanner}>
              Retry
            </button>
          </div>
        )}

        {showTorchHint && !torchOn && (
          <div className="hint">Low light detected? Try enabling the torch.</div>
        )}

        {focusMessage && <div className="hint secondary">{focusMessage}</div>}

        {zoomRange.max > zoomRange.min && (
          <div className="zoom-controls" role="group" aria-label="Zoom controls">
            <button type="button" onClick={() => void applyZoom(zoom - zoomRange.step)}>
              -
            </button>
            <span>{zoom.toFixed(1)}x</span>
            <button type="button" onClick={() => void applyZoom(zoom + zoomRange.step)}>
              +
            </button>
          </div>
        )}
      </section>

      <aside className={`history ${historyOpen ? 'open' : ''}`}>
        <div className="history-header">
          <h2>Session history</h2>
          <button type="button" onClick={resetSession} disabled={codes.length === 0}>
            Clear
          </button>
        </div>

        {codes.length === 0 ? (
          <p className="empty">No scans yet.</p>
        ) : (
          <ul>
            {codes.map((code) => (
              <li key={code.id}>
                <button type="button" onClick={() => setSelectedCode(code)}>
                  <span>{formatLabel(code.format)}</span>
                  <strong>{code.value}</strong>
                  <small>{getRelativeTime(sessionStart, code.detectedAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {selectedCode && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="Code actions">
          <div className="sheet-card">
            <h3>{formatLabel(selectedCode.format)}</h3>
            <p>{selectedCode.value}</p>
            <div className="sheet-actions">
              <button type="button" onClick={() => setViewerCode(selectedCode)}>
                View
              </button>
              <button
                type="button"
                onClick={openUrl}
                disabled={!isValidUrl(selectedCode.value)}
              >
                Open URL
              </button>
              <button type="button" onClick={() => void shareCode()}>
                Share
              </button>
              <button type="button" onClick={() => void copyCode()}>
                Copy
              </button>
              <button type="button" onClick={() => setSelectedCode(null)}>
                Close
              </button>
            </div>
          </div>
        </section>
      )}

      {viewerCode && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="Raw code content">
          <div className="sheet-card">
            <h3>Raw content</h3>
            <p>{viewerCode.value}</p>
            <button type="button" onClick={() => setViewerCode(null)}>
              Close
            </button>
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

export default App
