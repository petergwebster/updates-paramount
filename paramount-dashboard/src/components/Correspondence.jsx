import React, { useState, useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { supabase } from '../supabase'
import styles from './Correspondence.module.css'

const KPI_TAGS = [
  'Financial', 'Cost', 'Inventory', 'Quality', 'Delivery',
  'Collaboration', 'Grounds', 'Vendors', 'Growth', 'Passaic', 'General'
]

const DIRECTIONS = [
  { value: 'received', label: 'Received' },
  { value: 'sent', label: 'Sent' },
  { value: 'note', label: 'Internal Note' },
]

const CONTACT_TYPES = [
  { value: 'executive', label: 'Timur / Emily' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'client', label: 'Client' },
  { value: 'internal', label: 'Internal Team' },
  { value: 'other', label: 'Other' },
]

export default function Correspondence({ weekStart, dbReady }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [filterTag, setFilterTag] = useState('All')
  const [expandedId, setExpandedId] = useState(null)
  const [form, setForm] = useState({
    subject: '',
    contact: '',
    contact_type: 'executive',
    direction: 'received',
    kpi_tag: 'General',
    body: '',
    file_url: null,
    file_name: null,
  })
  const dropRef = useRef(null)
  const fileInputRef = useRef(null)
  const weekKey = format(weekStart, 'yyyy-MM-dd')

  useEffect(() => {
    loadItems()
    if (dbReady) {
      const channel = supabase
        .channel(`corr-${weekKey}`)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'correspondence',
          filter: `week_start=eq.${weekKey}`,
        }, () => loadItems())
        .subscribe()
      return () => supabase.removeChannel(channel)
    }
  }, [weekStart, dbReady])

  async function loadItems() {
    setLoading(true)
    const { data } = await supabase
      .from('correspondence')
      .select('*')
      .eq('week_start', weekKey)
      .order('created_at', { ascending: false })
    setItems(data || [])
    setLoading(false)
  }

  async function uploadFile(file) {
    setUploading(true)
    const ext = file.name.split('.').pop()
    const path = `${weekKey}/${Date.now()}-${file.name}`
    const { data, error } = await supabase.storage
      .from('correspondence')
      .upload(path, file, { contentType: file.type })

    if (!error) {
      const { data: urlData } = supabase.storage.from('correspondence').getPublicUrl(path)
      setForm(f => ({ ...f, file_url: urlData.publicUrl, file_name: file.name }))
    }
    setUploading(false)
    return !error
  }

  async function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      await uploadFile(file)
      setShowForm(true)
    }
  }

  async function handleFileInput(e) {
    const file = e.target.files[0]
    if (file) {
      await uploadFile(file)
      setShowForm(true)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.subject.trim()) return
    await supabase.from('correspondence').insert({
      week_start: weekKey,
      subject: form.subject,
      contact: form.contact,
      contact_type: form.contact_type,
      direction: form.direction,
      kpi_tag: form.kpi_tag,
      body: form.body,
      file_url: form.file_url,
      file_name: form.file_name,
      created_at: new Date().toISOString(),
    })
    setForm({ subject: '', contact: '', contact_type: 'executive', direction: 'received', kpi_tag: 'General', body: '', file_url: null, file_name: null })
    setShowForm(false)
    loadItems()
  }

  const filtered = filterTag === 'All' ? items : items.filter(i => i.kpi_tag === filterTag)

  const dirColor = (d) => ({
    received: styles.dirReceived,
    sent: styles.dirSent,
    note: styles.dirNote,
  }[d] || '')

  return (
    <div className={styles.container}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.sectionTitle}>Correspondence</h2>
          <p className={styles.sectionSub}>Emails, files, and notes — organized by week and topic. Drag a PDF or Word doc anywhere below to file it.</p>
        </div>
        <button className="primary" onClick={() => setShowForm(s => !s)}>
          {showForm ? 'Cancel' : '+ Add Correspondence'}
        </button>
      </div>

      {/* Drop Zone */}
      <div
        ref={dropRef}
        className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.eml" style={{ display: 'none' }} onChange={handleFileInput} />
        {uploading ? (
          <p className={styles.dropText}>Uploading…</p>
        ) : (
          <>
            <div className={styles.dropIcon}>↓</div>
            <p className={styles.dropText}>Drag & drop PDFs, Word docs, or email files here — or click to browse</p>
            <p className={styles.dropSub}>Supported: .pdf · .docx · .doc · .txt · .eml</p>
          </>
        )}
        {form.file_name && (
          <div className={styles.uploadedFile}>
            📎 {form.file_name} — ready to file
          </div>
        )}
      </div>

      {/* Email Paste Banner */}
      {!showForm && (
        <div className={styles.emailPasteBanner} onClick={() => setShowForm(true)}>
          <span className={styles.pasteIcon}>✉</span>
          <span>Paste an email — click to open the form and copy/paste email text directly</span>
        </div>
      )}

      {/* Add Form */}
      {showForm && (
        <form className={`${styles.addForm} fade-in`} onSubmit={handleSubmit}>
          <h3 className={styles.formTitle}>File correspondence</h3>
          <div className={styles.formGrid}>
            <div>
              <label className="label">Subject / Topic *</label>
              <input value={form.subject} onChange={e => setForm(f => ({...f, subject: e.target.value}))} placeholder="e.g. Zimmer Meeting Follow-up, Potsdam Paper Pricing" required />
            </div>
            <div>
              <label className="label">Contact Name</label>
              <input value={form.contact} onChange={e => setForm(f => ({...f, contact: e.target.value}))} placeholder="e.g. Andreas (Zimmer), Mike (Potsdam)" />
            </div>
            <div>
              <label className="label">Contact Type</label>
              <select value={form.contact_type} onChange={e => setForm(f => ({...f, contact_type: e.target.value}))}>
                {CONTACT_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Direction</label>
              <select value={form.direction} onChange={e => setForm(f => ({...f, direction: e.target.value}))}>
                {DIRECTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">KPI Category</label>
              <select value={form.kpi_tag} onChange={e => setForm(f => ({...f, kpi_tag: e.target.value}))}>
                {KPI_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="label">Email text or notes (paste full email here)</label>
            <textarea
              value={form.body}
              onChange={e => setForm(f => ({...f, body: e.target.value}))}
              placeholder="Paste the full email body here, or type a summary of the conversation…"
              rows={8}
              style={{ marginTop: 6 }}
            />
          </div>
          {form.file_name && (
            <div className={styles.attachedFile}>
              📎 Attached: <strong>{form.file_name}</strong>
              <button type="button" style={{ marginLeft: 8, fontSize: 12 }} onClick={() => setForm(f => ({...f, file_url: null, file_name: null}))}>Remove</button>
            </div>
          )}
          <div className={styles.formActions}>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
            <button type="submit" className="primary">Save Correspondence</button>
          </div>
        </form>
      )}

      {/* Filter */}
      <div className={styles.filterRow}>
        {['All', ...KPI_TAGS].map(tag => (
          <button
            key={tag}
            className={`${styles.filterBtn} ${filterTag === tag ? styles.filterBtnActive : ''}`}
            onClick={() => setFilterTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <p style={{ color: 'var(--ink-60)', fontSize: 13 }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No correspondence filed for this week yet.</p>
          <p style={{ marginTop: 6, fontSize: 13 }}>Drag a file in above or use the form to paste emails.</p>
        </div>
      ) : (
        <div className={styles.itemList}>
          {filtered.map(item => (
            <div key={item.id} className={styles.corrItem}>
              <div className={styles.corrTop} onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                <div className={styles.corrLeft}>
                  <span className={`${styles.dirBadge} ${dirColor(item.direction)}`}>
                    {item.direction === 'received' ? 'Received' : item.direction === 'sent' ? 'Sent' : 'Note'}
                  </span>
                  <div>
                    <div className={styles.corrSubject}>{item.subject}</div>
                    <div className={styles.corrMeta}>
                      {item.contact && <span>{item.contact}</span>}
                      {item.contact && <span className={styles.dot}>·</span>}
                      <span>{CONTACT_TYPES.find(c => c.value === item.contact_type)?.label || item.contact_type}</span>
                      <span className={styles.dot}>·</span>
                      <span>{new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    </div>
                  </div>
                </div>
                <div className={styles.corrRight}>
                  <span className={`badge badge-gray`} style={{ fontSize: 11 }}>{item.kpi_tag}</span>
                  {item.file_url && <span className={styles.fileIndicator}>📎</span>}
                  <span className={styles.chevron}>{expandedId === item.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expandedId === item.id && (
                <div className={`${styles.corrBody} fade-in`}>
                  {item.body && <pre className={styles.corrText}>{item.body}</pre>}
                  {item.file_url && (
                    <a href={item.file_url} target="_blank" rel="noopener noreferrer" className={styles.fileLink}>
                      📎 Open attached file: {item.file_name || 'attachment'}
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
