import React, { useState, useEffect } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './ProductionDashboard.module.css'

const NJ_TARGETS = {
  fabric: { yards: 834, colorYards: 4522 },
  grass: { yards: 3785, colorYards: 7570 },
  paper: { yards: 3830, colorYards: 13405 },
  wasteTarget: 8,
}

const BNY_TARGETS = {
  replen: 7886,
  mto: 1280,
  hos: 1532,
  memo: 211,
  contract: 1091,
  total: 12000,
}

function emptyNJ() {
  return {
    fabric: { yards: '', colorYards: '', waste: '', postWaste: '' },
    grass: { yards: '', colorYards: '', waste: '', postWaste: '' },
    paper: { yards: '', colorYards: '', waste: '', postWaste: '' },
    schWritten: '', schProduced: '', schInvoiced: '',
    tpWritten: '', tpProduced: '', tpInvoiced: '',
    commentary: '',
  }
}

function emptyBNY() {
  return {
    replen: '', mto: '', hos: '', memo: '', contract: '',
    schWritten: '', schProduced: '', schInvoiced: '',
    tpWritten: '', tpProduced: '', tpInvoiced: '',
    commentary: '',
  }
}

function pct(val, target) {
  const v = parseFloat(val)
  const t = parseFloat(target)
  if (!v || !t) return null
  return Math.round((v / t) * 100)
}

function statusColor(val, target, inverse = false) {
  const p = pct(val, target)
  if (p === null) return 'gray'
  if (inverse) {
    if (p <= 8) return 'green'
    if (p <= 12) return 'amber'
    return 'red'
  }
  if (p >= 90) return 'green'
  if (p >= 70) return 'amber'
  return 'red'
}

function Pill({ status, children }) {
  return <span className={`${styles.pill} ${styles['pill_' + status]}`}>{children}</span>
}

function BigStat({ label, value, target, unit = 'yds', inverse = false }) {
  const p = pct(value, target)
  const status = statusColor(value, target, inverse)
  return (
    <div className={styles.bigStat}>
      <div className={styles.bigStatLabel}>{label}</div>
      <div className={`${styles.bigStatValue} ${styles['bigStatValue_' + status]}`}>
        {value ? Number(value).toLocaleString() : '—'}
        <span className={styles.bigStatUnit}>{unit}</span>
      </div>
      {target && value && (
        <div className={styles.bigStatSub}>
          Target: {Number(target).toLocaleString()} {unit}
          {p !== null && <span className={`${styles.pctBadge} ${styles['pctBadge_' + status]}`}>{p}%</span>}
        </div>
      )}
    </div>
  )
}

function NumberInput({ label, value, onChange, placeholder }) {
  return (
    <div className={styles.inputGroup}>
      <label className="label">{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '0'}
        style={{ textAlign: 'right' }}
      />
    </div>
  )
}

export default function ProductionDashboard({ weekStart, dbReady }) {
  const [njData, setNjData] = useState(emptyNJ())
  const [bnyData, setBnyData] = useState(emptyBNY())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [mode, setMode] = useState('view') // 'view' | 'edit'
  const weekKey = format(weekStart, 'yyyy-MM-dd')

  useEffect(() => { loadData() }, [weekStart])

  async function loadData() {
    const { data } = await supabase
      .from('production')
      .select('*')
      .eq('week_start', weekKey)
      .single()
    if (data) {
      setNjData(data.nj_data || emptyNJ())
      setBnyData(data.bny_data || emptyBNY())
    } else {
      setNjData(emptyNJ())
      setBnyData(emptyBNY())
    }
  }

  async function handleSave() {
    setSaving(true)
    await supabase.from('production').upsert({
      week_start: weekKey,
      nj_data: njData,
      bny_data: bnyData,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'week_start' })
    setSaving(false)
    setSaved(true)
    setMode('view')
    setTimeout(() => setSaved(false), 2500)
  }

  function updateNJ(path, value) {
    const parts = path.split('.')
    setNjData(prev => {
      const next = { ...prev }
      if (parts.length === 2) {
        next[parts[0]] = { ...next[parts[0]], [parts[1]]: value }
      } else {
        next[parts[0]] = value
      }
      return next
    })
  }

  function updateBNY(key, value) {
    setBnyData(prev => ({ ...prev, [key]: value }))
  }

  const njTotalYards = ['fabric', 'grass', 'paper'].reduce((s, k) => s + (parseFloat(njData[k]?.yards) || 0), 0)
  const njTotalColor = ['fabric', 'grass', 'paper'].reduce((s, k) => s + (parseFloat(njData[k]?.colorYards) || 0), 0)
  const njTotalWaste = ['fabric', 'grass', 'paper'].reduce((s, k) => s + (parseFloat(njData[k]?.waste) || 0), 0)
  const njWastePct = njTotalYards > 0 ? ((njTotalWaste / njTotalYards) * 100).toFixed(1) : null
  const njTotalTarget = NJ_TARGETS.fabric.yards + NJ_TARGETS.grass.yards + NJ_TARGETS.paper.yards

  const bnyTotal = ['replen', 'mto', 'hos', 'memo', 'contract'].reduce((s, k) => s + (parseFloat(bnyData[k]) || 0), 0)

  const hasNJData = njTotalYards > 0
  const hasBNYData = bnyTotal > 0

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>Production Dashboard</h2>
          <p className={styles.sectionSub}>Weekly capacity & KPI summary — Passaic NJ + Brooklyn</p>
        </div>
        <div className={styles.actions}>
          {saved && <span className={styles.savedMsg}>Saved</span>}
          {mode === 'view' ? (
            <button onClick={() => setMode('edit')}>Edit Data</button>
          ) : (
            <>
              <button onClick={() => { setMode('view'); loadData() }}>Cancel</button>
              <button className="primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save & View'}
              </button>
            </>
          )}
        </div>
      </div>

      {mode === 'view' && (hasNJData || hasBNYData) ? (
        <div className={styles.summaryGrid}>
          {/* NJ SUMMARY */}
          <div className={styles.facilityCard}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}>
                <span className={styles.facilityBadge}>NJ</span>
                Passaic · Screen Print
              </div>
              <Pill status={statusColor(njTotalYards, njTotalTarget)}>
                {pct(njTotalYards, njTotalTarget)}% of target
              </Pill>
            </div>

            <div className={styles.statsRow}>
              <BigStat label="Total yards" value={njTotalYards || ''} target={njTotalTarget} />
              <BigStat label="Color yards" value={njTotalColor || ''} target={NJ_TARGETS.fabric.colorYards + NJ_TARGETS.grass.colorYards + NJ_TARGETS.paper.colorYards} />
              <BigStat label="Waste" value={njWastePct} target={NJ_TARGETS.wasteTarget} unit="%" inverse />
            </div>

            <div className={styles.categoryGrid}>
              {['fabric', 'grass', 'paper'].map(cat => {
                const d = njData[cat]
                const tgt = NJ_TARGETS[cat]
                const status = statusColor(d.yards, tgt.yards)
                return (
                  <div key={cat} className={`${styles.categoryCard} ${styles['categoryCard_' + status]}`}>
                    <div className={styles.categoryName}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</div>
                    <div className={styles.categoryYards}>
                      {d.yards ? Number(d.yards).toLocaleString() : '—'} yds
                    </div>
                    <div className={styles.categoryTarget}>Target: {tgt.yards.toLocaleString()}</div>
                    {d.waste && <div className={styles.categoryWaste}>Waste: {d.waste} yds</div>}
                  </div>
                )
              })}
            </div>

            {(njData.schProduced || njData.tpProduced) && (
              <div className={styles.splitRow}>
                <div className={styles.splitItem}>
                  <span className={styles.splitLabel}>Schumacher produced</span>
                  <span className={styles.splitValue}>{njData.schProduced ? Number(njData.schProduced).toLocaleString() + ' yds' : '—'}</span>
                </div>
                <div className={styles.splitItem}>
                  <span className={styles.splitLabel}>3rd party produced</span>
                  <span className={styles.splitValue}>{njData.tpProduced ? Number(njData.tpProduced).toLocaleString() + ' yds' : '—'}</span>
                </div>
              </div>
            )}

            {njData.commentary && (
              <div className={styles.commentary}>{njData.commentary}</div>
            )}
          </div>

          {/* BNY SUMMARY */}
          <div className={styles.facilityCard}>
            <div className={styles.facilityHeader}>
              <div className={styles.facilityTitle}>
                <span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span>
                Brooklyn · Digital
              </div>
              <Pill status={statusColor(bnyTotal, BNY_TARGETS.total)}>
                {pct(bnyTotal, BNY_TARGETS.total)}% of target
              </Pill>
            </div>

            <div className={styles.statsRow}>
              <BigStat label="Total yards" value={bnyTotal || ''} target={BNY_TARGETS.total} />
            </div>

            <div className={styles.categoryGrid}>
              {['replen', 'mto', 'hos', 'memo', 'contract'].map(cat => {
                const val = bnyData[cat]
                const tgt = BNY_TARGETS[cat]
                const status = statusColor(val, tgt)
                return (
                  <div key={cat} className={`${styles.categoryCard} ${styles['categoryCard_' + status]}`}>
                    <div className={styles.categoryName}>{cat.toUpperCase()}</div>
                    <div className={styles.categoryYards}>
                      {val ? Number(val).toLocaleString() : '—'} yds
                    </div>
                    <div className={styles.categoryTarget}>Target: {tgt.toLocaleString()}</div>
                  </div>
                )
              })}
            </div>

            {(bnyData.schProduced || bnyData.tpProduced) && (
              <div className={styles.splitRow}>
                <div className={styles.splitItem}>
                  <span className={styles.splitLabel}>Schumacher produced</span>
                  <span className={styles.splitValue}>{bnyData.schProduced ? Number(bnyData.schProduced).toLocaleString() + ' yds' : '—'}</span>
                </div>
                <div className={styles.splitItem}>
                  <span className={styles.splitLabel}>3rd party produced</span>
                  <span className={styles.splitValue}>{bnyData.tpProduced ? Number(bnyData.tpProduced).toLocaleString() + ' yds' : '—'}</span>
                </div>
              </div>
            )}

            {bnyData.commentary && (
              <div className={styles.commentary}>{bnyData.commentary}</div>
            )}
          </div>
        </div>
      ) : mode === 'view' ? (
        <div className={styles.emptyState}>
          <p>No production data entered yet for this week.</p>
          <button className="primary" style={{ marginTop: 12 }} onClick={() => setMode('edit')}>Enter This Week's Data</button>
        </div>
      ) : null}

      {/* EDIT MODE */}
      {mode === 'edit' && (
        <div className={styles.editGrid}>
          {/* NJ EDIT */}
          <div className={styles.editSection}>
            <div className={styles.editSectionHeader}>
              <span className={styles.facilityBadge}>NJ</span>
              <h3>Passaic — Screen Print</h3>
            </div>

            <div className={styles.editSubHeader}>Capacity (yards produced)</div>
            <div className={styles.editRow}>
              {['fabric', 'grass', 'paper'].map(cat => (
                <div key={cat} className={styles.editCatBlock}>
                  <div className={styles.editCatLabel}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</div>
                  <NumberInput label="Yards" value={njData[cat].yards} onChange={v => updateNJ(`${cat}.yards`, v)} placeholder={NJ_TARGETS[cat].yards} />
                  <NumberInput label="Color yards" value={njData[cat].colorYards} onChange={v => updateNJ(`${cat}.colorYards`, v)} placeholder={NJ_TARGETS[cat].colorYards} />
                  <NumberInput label="Waste (yds)" value={njData[cat].waste} onChange={v => updateNJ(`${cat}.waste`, v)} />
                  <NumberInput label="Post-prod waste" value={njData[cat].postWaste} onChange={v => updateNJ(`${cat}.postWaste`, v)} />
                </div>
              ))}
            </div>

            <div className={styles.editSubHeader}>Schumacher vs 3rd Party</div>
            <div className={styles.editThreeCol}>
              {[['Written', 'Written'], ['Produced', 'Produced'], ['Invoiced', 'Invoiced']].map(([label, key]) => (
                <div key={key}>
                  <NumberInput label={`SCH ${label}`} value={njData[`sch${key}`]} onChange={v => updateNJ(`sch${key}`, v)} />
                  <NumberInput label={`3P ${label}`} value={njData[`tp${key}`]} onChange={v => updateNJ(`tp${key}`, v)} />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="label">Commentary</label>
              <textarea value={njData.commentary} onChange={e => updateNJ('commentary', e.target.value)} placeholder="Fabric waiting on approvals, Grass working on Feather Bloom…" rows={3} style={{ marginTop: 6 }} />
            </div>
          </div>

          {/* BNY EDIT */}
          <div className={styles.editSection}>
            <div className={styles.editSectionHeader}>
              <span className={`${styles.facilityBadge} ${styles.facilityBadgeBNY}`}>BK</span>
              <h3>Brooklyn — Digital</h3>
            </div>

            <div className={styles.editSubHeader}>Capacity by category</div>
            <div className={styles.editFiveCol}>
              {['replen', 'mto', 'hos', 'memo', 'contract'].map(cat => (
                <NumberInput key={cat} label={cat.toUpperCase()} value={bnyData[cat]} onChange={v => updateBNY(cat, v)} placeholder={BNY_TARGETS[cat]} />
              ))}
            </div>

            <div className={styles.editSubHeader} style={{ marginTop: 16 }}>Schumacher vs 3rd Party</div>
            <div className={styles.editThreeCol}>
              {[['Written', 'Written'], ['Produced', 'Produced'], ['Invoiced', 'Invoiced']].map(([label, key]) => (
                <div key={key}>
                  <NumberInput label={`SCH ${label}`} value={bnyData[`sch${key}`]} onChange={v => updateBNY(`sch${key}`, v)} />
                  <NumberInput label={`3P ${label}`} value={bnyData[`tp${key}`]} onChange={v => updateBNY(`tp${key}`, v)} />
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <label className="label">Commentary</label>
              <textarea value={bnyData.commentary} onChange={e => updateBNY('commentary', e.target.value)} placeholder="Replen running ahead, MTO on track…" rows={3} style={{ marginTop: 6 }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
