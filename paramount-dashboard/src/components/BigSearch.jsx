// BigSearch — the prominent find-my-order bar for the Procurement boards.
//
// Peter, 8/5 (after the procurement team demo): searching a specific PO or
// pattern name is HOW this team will use these boards — so the search cannot
// be a small input hiding in a filter-chip row. One shared component so every
// board's search looks the same, sits in the same place (right under the
// title), and behaves the same (live filter, clear button, match count).

import { C } from '../lib/scheduleUtils'

export default function BigSearch({ value, onChange, placeholder, count = null, autoFocus = false }) {
  return (
    <div style={{ position: 'relative', margin: '10px 0 14px', maxWidth: 680 }}>
      <span style={{
        position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
        fontSize: 14, pointerEvents: 'none',
      }}>🔍</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '12px 96px 12px 42px',
          fontSize: 14, borderRadius: 10,
          // Brand clay outline (the PP monogram color) — deliberately NOT a
          // status green/amber so the bar never reads as a state indicator.
          border: '2px solid #D97757',
          boxShadow: value
            ? '0 0 0 4px rgba(217,119,87,0.25)'
            : '0 0 0 3px rgba(217,119,87,0.12)',
          background: 'var(--surface)', color: C.ink,
          outline: 'none',
        }}
      />
      {value && count != null && (
        <span style={{
          position: 'absolute', right: 40, top: '50%', transform: 'translateY(-50%)',
          fontSize: 11, color: count > 0 ? C.inkMid : C.rose, fontWeight: 700, whiteSpace: 'nowrap',
        }}>
          {count} match{count === 1 ? '' : 'es'}
        </span>
      )}
      {value && (
        <button onClick={() => onChange('')} title="Clear search"
          style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            border: 'none', background: 'transparent', color: C.inkLight,
            fontSize: 15, cursor: 'pointer', padding: 6, lineHeight: 1,
          }}>
          ✕
        </button>
      )}
    </div>
  )
}
