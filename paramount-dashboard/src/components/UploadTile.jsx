import React, { useState, useRef, useEffect } from 'react'
import { getCurrentSnapshot, getSnapshotHistory } from '../lib/persistSnapshot'
import { validateFile, fileKindLabel, expectedFilenamePattern } from '../lib/fileFingerprint'
import styles from './UploadTile.module.css'

/**
 * UploadTile — one of the three upload slots in LIFTDataRefresh.
 *
 * Each tile shows:
 *   - File kind label and expected filename hint
 *   - Last upload metadata (when, who, status, sheets parsed) from data_snapshots
 *   - Freshness indicator (green if <30hr, amber if 30-48hr, red if >48hr or never)
 *   - Drop zone for new uploads
 *   - Validation feedback
 *   - Error display when parse fails
 *
 * Stage B status: tile renders fully, drag-drop works, file validation runs,
 * but the actual parse+persist is stubbed (just shows "Stage C will wire this").
 *
 * Props:
 *   fileKind: 'wip' | 'mos' | 'inventory'
 *   onUpload: optional callback(fileKind, file) — called when a valid file is dropped
 *             Stage B passes nothing; Stage C passes the parser entry point.
 */
export default function UploadTile({ fileKind, onUpload }) {
  const [currentSnapshot, setCurrentSnapshot] = useState(null)
  const [history, setHistory]                 = useState([])
  const [loading, setLoading]                 = useState(true)
  const [dragActive, setDragActive]           = useState(false)
  const [validating, setValidating]           = useState(false)
  const [validationResult, setValidationResult] = useState(null)
  const [showHistory, setShowHistory]         = useState(false)
  const inputRef = useRef(null)

  const label = fileKindLabel(fileKind)
  const expectedFile = expectedFilenamePattern(fileKind)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      getCurrentSnapshot(fileKind),
      getSnapshotHistory(fileKind, 10),
    ]).then(([current, hist]) => {
      if (cancelled) return
      setCurrentSnapshot(current)
      setHistory(hist)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [fileKind])

  const refreshSnapshots = async () => {
    const [current, hist] = await Promise.all([
      getCurrentSnapshot(fileKind),
      getSnapshotHistory(fileKind, 10),
    ])
    setCurrentSnapshot(current)
    setHistory(hist)
  }

  // ─── File handling ───
  async function handleFile(file) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xls')) {
      setValidationResult({
        ok: false,
        error: `Need an Excel file (.xlsx or .xls). You picked: ${file.name}`,
      })
      return
    }

    setValidating(true)
    setValidationResult(null)

    try {
      const buffer = await file.arrayBuffer()
      const result = validateFile(buffer, file.name, fileKind)
      setValidationResult(result)

      if (result.ok && onUpload) {
        // Stage C wires the actual parse + persist
        await onUpload(fileKind, file, buffer, () => {
          // After upload completes, refresh the tile
          refreshSnapshots()
          setValidationResult(null)
        })
      }
    } catch (e) {
      setValidationResult({
        ok: false,
        error: `Failed to read file: ${e?.message || 'Unknown error'}`,
      })
    } finally {
      setValidating(false)
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) handleFile(file)
  }

  function handleSelect(e) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // reset input so same file can be picked twice
    e.target.value = ''
  }

  // ─── Compute freshness tone ───
  const freshness = computeFreshness(currentSnapshot?.uploaded_at)

  return (
    <div className={`${styles.tile} ${styles[`tile_${freshness.tone}`]}`}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div>
          <div className={styles.label}>{label}</div>
          <div className={styles.expectedFile}>{expectedFile}</div>
        </div>
        <FreshnessChip freshness={freshness} />
      </div>

      {/* ── Last-upload summary ── */}
      <div className={styles.lastUpload}>
        {loading ? (
          <span className={styles.loading}>Loading…</span>
        ) : currentSnapshot ? (
          <CurrentSnapshotSummary snap={currentSnapshot} />
        ) : (
          <span className={styles.noUpload}>
            <em>No uploads yet — drop a file below to start.</em>
          </span>
        )}
      </div>

      {/* ── Drop zone ── */}
      <div
        className={`${styles.dropZone} ${dragActive ? styles.dropZoneActive : ''} ${validating ? styles.dropZoneBusy : ''}`}
        onDragEnter={e => { e.preventDefault(); setDragActive(true) }}
        onDragOver={e => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={e => { e.preventDefault(); setDragActive(false) }}
        onDrop={handleDrop}
        onClick={() => !validating && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={handleSelect}
        />
        {validating ? (
          <div className={styles.dropZoneText}>
            <div className={styles.spinner} />
            <span>Reading file…</span>
          </div>
        ) : (
          <div className={styles.dropZoneText}>
            <div className={styles.dropIcon}>↑</div>
            <span><strong>Drop file here</strong> or click to choose</span>
            <div className={styles.dropHint}>Today's {label.toLowerCase()}</div>
          </div>
        )}
      </div>

      {/* ── Validation feedback ── */}
      {validationResult && !validationResult.ok && (
        <div className={styles.validationError}>
          <strong>Can't use this file</strong>
          <p>{validationResult.error}</p>
          {validationResult.suggestedKind && (
            <p className={styles.suggestion}>
              ↳ Looks like the {fileKindLabel(validationResult.suggestedKind)}.
              Try uploading it to that slot instead.
            </p>
          )}
          {validationResult.sheetNames && validationResult.sheetNames.length > 0 && (
            <details className={styles.sheetDetails}>
              <summary>Sheets found in this file</summary>
              <ul>
                {validationResult.sheetNames.map(s => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {validationResult && validationResult.ok && !onUpload && (
        <div className={styles.validationOk}>
          <strong>File looks good</strong>
          <p>
            Upload pipeline (parsers + database write) lands in Stage C.
            For now this just confirms the file structure matches expectations.
          </p>
        </div>
      )}

      {/* ── History toggle ── */}
      {history.length > 0 && (
        <div className={styles.historyToggle}>
          <button onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide' : 'Show'} recent uploads ({history.length})
          </button>
        </div>
      )}

      {showHistory && history.length > 0 && (
        <div className={styles.historyPanel}>
          {history.map(h => (
            <HistoryRow key={h.id} snap={h} isCurrent={currentSnapshot?.id === h.id} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── helpers + subcomponents ───────────────────────────────────────────── */

function computeFreshness(uploadedAt) {
  if (!uploadedAt) return { tone: 'crimson', label: 'No uploads', hours: null }
  const ageMs = Date.now() - new Date(uploadedAt).getTime()
  const hours = Math.floor(ageMs / (1000 * 60 * 60))
  if (hours < 30) return { tone: 'emerald', label: 'Fresh', hours }
  if (hours < 48) return { tone: 'saffron', label: 'Aging', hours }
  return { tone: 'crimson', label: 'Stale', hours }
}

function FreshnessChip({ freshness }) {
  let text = freshness.label
  if (freshness.hours !== null) {
    if (freshness.hours < 1) text = 'Fresh · just now'
    else if (freshness.hours < 24) text = `Fresh · ${freshness.hours}h ago`
    else {
      const days = Math.floor(freshness.hours / 24)
      const label = freshness.tone === 'emerald' ? 'Fresh' : freshness.tone === 'saffron' ? 'Aging' : 'Stale'
      text = `${label} · ${days}d ago`
    }
  }
  return (
    <span className={`${styles.chip} ${styles[`chip_${freshness.tone}`]}`}>
      {text}
    </span>
  )
}

function CurrentSnapshotSummary({ snap }) {
  const sheetsParsed = Object.entries(snap.sheets_parsed || {})
  const totalRows = sheetsParsed.reduce((s, [, n]) => s + (Number(n) || 0), 0)
  const errorCount = Object.keys(snap.errors || {}).filter(k => k !== '_write_errors').length
  const dt = new Date(snap.uploaded_at)

  return (
    <div className={styles.summaryGrid}>
      <div>
        <div className={styles.summaryLabel}>Last upload</div>
        <div className={styles.summaryValue}>
          {dt.toLocaleDateString()} · {dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </div>
      </div>
      <div>
        <div className={styles.summaryLabel}>Status</div>
        <div className={styles.summaryValue}>
          <StatusPill status={snap.status} />
        </div>
      </div>
      <div>
        <div className={styles.summaryLabel}>Source</div>
        <div className={styles.summaryValue}>
          {snap.source === 'sharefile_auto' ? 'Auto · ShareFile' : 'Manual'}
          {snap.uploaded_by_email && (
            <span className={styles.summaryEmail}> · {shortenEmail(snap.uploaded_by_email)}</span>
          )}
        </div>
      </div>
      <div>
        <div className={styles.summaryLabel}>Rows captured</div>
        <div className={styles.summaryValue}>
          {totalRows.toLocaleString()}
          {sheetsParsed.length > 0 && (
            <span className={styles.summarySub}> · {sheetsParsed.length} sheets</span>
          )}
          {errorCount > 0 && (
            <span className={styles.summaryError}> · {errorCount} sheet error{errorCount > 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryRow({ snap, isCurrent }) {
  const dt = new Date(snap.uploaded_at)
  return (
    <div className={`${styles.historyRow} ${isCurrent ? styles.historyRowCurrent : ''}`}>
      <span className={styles.historyDate}>
        {dt.toLocaleDateString()} {dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </span>
      <StatusPill status={snap.status} small />
      <span className={styles.historyEmail}>{shortenEmail(snap.uploaded_by_email)}</span>
      {isCurrent && <span className={styles.historyCurrentBadge}>Current</span>}
    </div>
  )
}

function StatusPill({ status, small = false }) {
  const tone = {
    success: 'emerald',
    partial: 'saffron',
    failed:  'crimson',
    parsing: 'royal',
    pending: 'muted',
  }[status] || 'muted'
  return (
    <span className={`${styles.statusPill} ${styles[`status_${tone}`]} ${small ? styles.statusPillSmall : ''}`}>
      {status}
    </span>
  )
}

function shortenEmail(email) {
  if (!email) return ''
  const [user, domain] = email.split('@')
  if (!domain) return email
  // pwebster@fsco.com → pwebster
  return user
}
