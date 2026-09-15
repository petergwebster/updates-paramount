import { getDemoSnapshotId, exitDemoMode } from '../lib/demoMode'

// DemoBanner — unmissable red strip shown ONLY when demo mode pins the tab to
// a frozen QA1 snapshot (?demo=<id>). Nobody should ever mistake sandbox data
// for the live pool, in either direction.
export default function DemoBanner() {
  const id = getDemoSnapshotId()
  if (!id) return null
  return (
    <div style={{
      background: '#B91C1C', color: '#fff', padding: '10px 16px', borderRadius: 8,
      margin: '12px 0 16px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', gap: 12, fontSize: 14, fontWeight: 600,
    }}>
      <span>DEMO MODE — QA1 sandbox data (snapshot {id}). This is NOT the live production pool.</span>
      <button
        onClick={exitDemoMode}
        style={{ background: '#fff', color: '#B91C1C', border: 'none', borderRadius: 6,
                 padding: '6px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 13, flexShrink: 0 }}>
        Exit demo
      </button>
    </div>
  )
}
