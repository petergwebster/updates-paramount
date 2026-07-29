import React, { useState, useEffect } from 'react'
import { supabase } from '../supabase'

// ═══════════════════════════════════════════════════════════════════════════
// MonthEndDecks — the exec deck library.
//
// These are the MANUAL month-end decks, exactly as presented to FSCO
// leadership, saved by Peter as PDFs into ShareFile > "Paramount Month End
// Decks" and picked up automatically by the daily finance feed (there is no
// upload button here, deliberately — the ShareFile folder IS the intake, the
// same pattern as Vena and payroll).
//
// LONG-TERM DIRECTION (Peter, 2026-07-28): auto-generating these decks from
// live data is the standing goal, blocked today on the yard-identity
// reconciliation and several missing captures. When generation arrives it
// lands NEXT TO these files in this same section, so the transition is a
// comparison, not a replacement. Until then this shelf is the touchpoint:
// every month's deck, one click, newest first.
// ═══════════════════════════════════════════════════════════════════════════

const SB_URL = import.meta.env.VITE_SUPABASE_URL

const fmtSize = (b) => {
  if (!b) return ''
  if (b > 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB'
  return Math.round(b / 1024) + ' KB'
}

export default function MonthEndDecks() {
  const [decks, setDecks] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const { data, error } = await supabase.from('month_end_decks')
        .select('*').order('period', { ascending: false })
      if (dead) return
      if (error) setErr(error.message)
      else setDecks(data || [])
      setLoading(false)
    })()
    return () => { dead = true }
  }, [])

  const urlFor = (d) =>
    `${SB_URL}/storage/v1/object/public/decks/${encodeURIComponent(d.storage_path)}`

  const S = {
    wrap: { padding: '8px 28px 28px', maxWidth: 1180, margin: '0 auto' },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 },
    card: { display: 'block', textDecoration: 'none', padding: '18px 18px 14px', borderRadius: 12,
            background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink)' },
    mon:  { fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 600, letterSpacing: '0.02em' },
    yr:   { fontSize: 12, color: 'var(--ink-60)', marginTop: 2 },
    meta: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginTop: 16, fontSize: 11, color: 'var(--ink-40)' },
    pdf:  { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', padding: '2px 6px',
            borderRadius: 4, border: '1px solid var(--ink-40)', color: 'var(--ink-60)' },
    note: { fontSize: 12, color: 'var(--ink-60)', marginTop: 20, lineHeight: 1.6 },
  }

  return (
    <div style={S.wrap}>
      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>Loading…</div>
      ) : err ? (
        <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>
      ) : !decks.length ? (
        <div style={{ fontSize: 13, color: 'var(--ink-60)' }}>
          No decks loaded yet. Save each month-end deck as a PDF into
          ShareFile &rsaquo; &ldquo;Paramount Month End Decks&rdquo; — the daily feed picks it up
          from there automatically.
        </div>
      ) : (
        <div style={S.grid}>
          {decks.map(d => {
            const [mon, ...rest] = (d.month_label || d.file_name).split(' ')
            return (
              <a key={d.file_name} href={urlFor(d)} target="_blank" rel="noreferrer" style={S.card}>
                <div style={S.mon}>{mon}</div>
                <div style={S.yr}>{rest.join(' ')}</div>
                <div style={S.meta}>
                  <span style={S.pdf}>PDF</span>
                  <span>{fmtSize(d.file_size)}</span>
                </div>
              </a>
            )
          })}
        </div>
      )}
      <div style={S.note}>
        The deck as presented, every month. New decks appear here automatically the morning
        after the PDF lands in the ShareFile folder. Auto-generating these from live dashboard
        data is the standing longer-term goal — when that arrives, it lands beside these,
        as a comparison.
      </div>
    </div>
  )
}
