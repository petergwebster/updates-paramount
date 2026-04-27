import React from 'react'

/**
 * StubPage — a clean placeholder for tabs that are routed but not yet built.
 * Used during the phased remodel rollout so the navigation works end-to-end
 * even where the real implementation is still pending.
 *
 * Props:
 *   title       — page title (large, serif)
 *   eyebrow     — small label above title (e.g. "Operations View")
 *   description — short description of what the real page will do
 *   note        — small italic note explaining timing / dependencies
 */
export default function StubPage({ title, eyebrow, description, note }) {
  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '36px 24px 80px' }}>
      <div style={{ marginBottom: 28 }}>
        {eyebrow && (
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-40)',
            marginBottom: 8,
          }}>
            {eyebrow}
          </div>
        )}
        <h1 style={{
          margin: 0,
          fontSize: 30,
          fontWeight: 700,
          color: 'var(--ink)',
          fontFamily: 'Georgia, serif',
          lineHeight: 1.15,
        }}>
          {title}
        </h1>
        {description && (
          <div style={{
            marginTop: 6,
            fontSize: 13,
            color: 'var(--ink-40)',
          }}>
            {description}
          </div>
        )}
      </div>

      <div style={{
        background: 'white',
        border: '1px dashed var(--ink-20)',
        borderRadius: 8,
        padding: '60px 40px',
        textAlign: 'center',
        color: 'var(--ink-40)',
        fontSize: 14,
        lineHeight: 1.7,
      }}>
        <div style={{
          fontFamily: 'Georgia, serif',
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--ink)',
          marginBottom: 10,
        }}>
          🛠 Under construction
        </div>
        <div style={{ maxWidth: 520, margin: '0 auto 14px' }}>
          {description || 'This page is part of the dashboard remodel and will be built shortly.'}
        </div>
        {note && (
          <div style={{
            fontSize: 12,
            color: 'var(--ink-30)',
            fontStyle: 'italic',
            marginTop: 14,
          }}>
            {note}
          </div>
        )}
      </div>
    </div>
  )
}
