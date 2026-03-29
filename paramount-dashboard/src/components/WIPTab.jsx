import { useState, useMemo } from 'react'

const TOKEN = import.meta.env.VITE_MONDAY_TOKEN || ''
const BOARD_ID = '6053588909'

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  cream:'#FAF7F2', parchment:'#F2EDE4', warm:'#E8DDD0', border:'#DDD4C8',
  ink:'#2C2420', inkMid:'#5C4F47', inkLight:'#9C8F87',
  gold:'#B8860B', goldLight:'#D4A843', goldBg:'#FDF8EC',
  navy:'#1E3A5F', navyLight:'#E8EEF5',
  amber:'#C17F24', amberBg:'#FEF3E2',
  sage:'#4A6741', sageBg:'#EEF3EC',
  rose:'#8B3A3A', roseBg:'#F9EDED',
  slate:'#4A5568', slateBg:'#EDF2F7',
}

// ─── Monday API ───────────────────────────────────────────────────────────────
async function fetchAllItems() {
  const call = async (query) => {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN, 'API-Version': '2024-01' },
      body: JSON.stringify({ query })
    })
    return res.json()
  }
  const q = (cursor) => cursor
    ? `{ next_items_page(limit:500,cursor:"${cursor}"){cursor items{id name group{id title}column_values{id text}}}}`
    : `{ boards(ids:${BOARD_ID}){items_page(limit:500){cursor items{id name group{id title}column_values{id text}}}}}`
  let all=[], d=await call(q(null)), page=d.data?.boards?.[0]?.items_page
  if(!page) throw new Error('Monday API error: '+JSON.stringify(d.errors||d))
  all=(page.items||[]).filter(i=>i&&Array.isArray(i.column_values)); let cursor=page.cursor, n=0
  while(cursor&&n<20){
    d=await call(q(cursor)); page=d.data?.next_items_page
    if(!page?.items?.length) break
    all=[...all,...(page.items||[]).filter(i=>i&&Array.isArray(i.column_values))]; cursor=page.cursor; n++
  }
  return all
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const col  = (item,id) => item?.column_values?.find(c=>c.id===id)?.text?.trim()||''
const yds  = item => parseFloat(col(item,'text')?.replace(/,/g,''))||0
const wipA = item => parseFloat(col(item,'numeric_mm1t59xg')?.replace(/,/g,''))||0
const ytop = item => parseFloat(col(item,'numeric_mm1p86dj')?.replace(/,/g,''))||0
const fmt  = n => n.toLocaleString(undefined,{maximumFractionDigits:0})
const fmtD = n => '$'+n.toLocaleString(undefined,{maximumFractionDigits:0})

function getDept(item){
  const d=col(item,'status_12').toUpperCase()
  if(d.includes('WALLPAPER')||d.includes('WP COLOR')) return 'Wallpaper'
  if(d.includes('GRASSCLOTH')||d.includes('GC COLOR')) return 'Grasscloth'
  if(d.includes('FABRIC')) return 'Fabric'
  if(d.includes('ROTARY')) return 'Rotary'
  return d||'Other'
}

// ─── Date bucketing — fixed: blank ESD = 'No Date' not '90+' ─────────────────
const DATE_BUCKETS = ['90+ days','61–90 days','31–60 days','0–30 days','No Date']
const BUCKET_COLORS = {
  '90+ days':   {bg:C.roseBg,   text:C.rose,     border:'#E8A0A0'},  // oldest = most urgent
  '61–90 days': {bg:C.amberBg,  text:C.amber,    border:'#F0C070'},
  '31–60 days': {bg:C.goldBg,   text:C.gold,     border:'#E0C060'},
  '0–30 days':  {bg:C.sageBg,   text:C.sage,     border:'#A0C8A0'},  // freshest = green
  'No Date':    {bg:C.warm,     text:C.inkLight, border:C.border},
}

function getBucket(item){
  const esd=col(item,'date4')
  if(!esd) return 'No Date'                           // ← fix: blank = own bucket
  const parts=esd.split('-')
  if(parts.length!==3) return 'No Date'
  const d=new Date(parseInt(parts[0]),parseInt(parts[1])-1,parseInt(parts[2])) // local parse
  const today=new Date(); today.setHours(0,0,0,0)
  const diff=Math.floor((d-today)/(1000*60*60*24))
  if(diff<0)   return 'No Date'
  if(diff<=30) return '0–30 days'
  if(diff<=60) return '31–60 days'
  if(diff<=90) return '61–90 days'
  return '90+ days'
}

function statusDot(s){
  const u=(s||'').toUpperCase()
  if(u==='COMPLETE') return C.sage
  if(u==='IN PRODUCTION'||u==='MIXING') return C.navy
  if(u==='APPROVED FOR PROD') return C.gold
  if(u.includes('WAITING')||u==='NOT STARTED'||u==='INBOUND') return C.amber
  if(u==='CANCELLED') return C.rose
  return C.inkLight
}

const DEPT_C = {
  Wallpaper:  {bg:C.navyLight, text:C.navy,  bar:C.navy},
  Grasscloth: {bg:C.sageBg,   text:C.sage,  bar:C.sage},
  Fabric:     {bg:C.amberBg,  text:C.amber, bar:C.amber},
  Rotary:     {bg:C.slateBg,  text:C.slate, bar:C.slate},
}
const dc = d => DEPT_C[d]||{bg:C.parchment,text:C.inkMid,bar:C.inkLight}

// ─── Classification ───────────────────────────────────────────────────────────
const HTI_G  = new Set(['HELD TO INVOICE CURRENT','3-27-26 PICK UP','shipping this week','NEW SHIPPED MARCH'])
const POST_G = new Set(['POST PRODUCTION - FREIGHT','POST PRODUCTION - SHIP DIRECT'])
const HOLD_G = new Set(['ON HOLD','Backstock','SCHUMACHER SHORT SHIPPED SKUS','SYSTEM ISSUES?',
  'MISSING STANDARD/WAITING ON SAMPLE1','STOCK CHECK','IN QA / INSPECTION','PENDING CFA APPROVAL',
  'Tillett SKO APPROVED NO ORDERS','GROUND ORDERS SCHUMACHER',
  'HARUKI - FULFILL IN JANUARY','HARUKI - FULFILL IN FEBRUARY','HARUKI - FULFILL IN MARCH','Fulfill from Stock'])
const isSched = t => /^(MON|TUE|WED|THURS|FRI)\b/i.test(t)||/^WEEK\s/i.test(t)

function classify(item){
  const g=item.group?.title||''
  const gt=col(item,'status_1__1')
  const sw=col(item,'dropdown_mm1xk5rp')
  if(isSched(g)||sw==='SCHEDULE') return 'SCHEDULE'
  if(HTI_G.has(g)) return 'HTI'
  if(POST_G.has(g)) return 'POST'
  if(HOLD_G.has(g)) return 'HOLD'
  if(gt==='NEW GOODS') return 'NEW_GOODS'
  return 'WIP'
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────
function dayKey(t){ const m=t.match(/^(MON|TUE|WED|THURS|FRI)/i); return m?m[1].toUpperCase():null }
function parseGrpDate(t){
  const m=t.match(/(\d+)\/(\d+)/); if(!m) return null
  return new Date(new Date().getFullYear(),parseInt(m[1])-1,parseInt(m[2]))
}

// ─── Mini bar chart ───────────────────────────────────────────────────────────
function BucketChart({ items }) {
  const byBucket = {}
  DATE_BUCKETS.forEach(b => { byBucket[b]={count:0,yards:0} })
  items.forEach(i => { const b=getBucket(i); if(byBucket[b]) { byBucket[b].count++; byBucket[b].yards+=yds(i) } })
  const maxYds = Math.max(...Object.values(byBucket).map(v=>v.yards),1)
  const hasData = items.length > 0

  if(!hasData) return null
  return (
    <div style={{background:'#fff',borderRadius:10,border:`1px solid ${C.border}`,padding:'14px 18px',marginBottom:16}}>
      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:C.inkLight,marginBottom:12}}>WIP Aging by Order Date</div>
      <div style={{display:'flex',gap:8,alignItems:'flex-end',height:80}}>
        {DATE_BUCKETS.filter(b=>byBucket[b].count>0).map(b=>{
          const v=byBucket[b]; const bc=BUCKET_COLORS[b]
          const pct=Math.max((v.yards/maxYds)*100,4)
          return (
            <div key={b} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3}}>
              <span style={{fontSize:10,fontWeight:600,color:bc.text}}>{fmt(v.yards)}</span>
              <div style={{width:'100%',height:pct*0.6+'px',background:bc.text,borderRadius:'3px 3px 0 0',opacity:0.85,transition:'height 0.5s'}}/>
              <span style={{fontSize:9,color:C.inkLight,textAlign:'center',lineHeight:1.2}}>{b}</span>
              <span style={{fontSize:9,fontWeight:600,color:bc.text}}>{v.count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Detail / filter panel ────────────────────────────────────────────────────
function Detail({label,value,color}){
  if(!value) return null
  return <div style={{fontSize:11}}><span style={{color:C.inkLight,marginRight:4}}>{label}:</span><span style={{color:color||C.inkMid,fontWeight:600}}>{value}</span></div>
}

function Pill({label,bg,text}){
  return <span style={{fontSize:10,padding:'2px 7px',borderRadius:4,background:bg,color:text,fontWeight:500}}>{label}</span>
}

function FilterBtn({active,onClick,children,activeColor}){
  return (
    <button onClick={onClick} style={{padding:'3px 10px',fontSize:11,borderRadius:5,cursor:'pointer',border:`1px solid ${active?(activeColor||C.ink):C.border}`,background:active?(activeColor||C.ink):'transparent',color:active?'#fff':C.inkMid,fontWeight:active?700:400,transition:'all 0.15s'}}>
      {children}
    </button>
  )
}

function OrderRow({item}){
  const [open,setOpen]=useState(false)
  const d=getDept(item), status=col(item,'status5'), bucket=getBucket(item)
  const bc=BUCKET_COLORS[bucket]
  const yd=yds(item), tp=ytop(item), wip=wipA(item)

  return (
    <div style={{borderBottom:`1px solid ${C.border}`,background:open?C.parchment:'transparent',transition:'background 0.1s'}}>
      <div onClick={()=>setOpen(!open)} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 16px',cursor:'pointer'}}>
        <span style={{fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:3,background:dc(d).bg,color:dc(d).text,whiteSpace:'nowrap',minWidth:60,textAlign:'center',letterSpacing:'0.04em'}}>{d.toUpperCase().slice(0,6)}</span>
        <span style={{flex:1,fontSize:13,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500}}>{item.name}</span>
        {col(item,'status_1__1')==='NEW GOODS'&&<span style={{fontSize:9,fontWeight:700,padding:'1px 5px',borderRadius:3,background:C.amberBg,color:C.amber,whiteSpace:'nowrap'}}>NEW GOODS</span>}
        {col(item,'status_1__1')==='TRANSITION'&&<span style={{fontSize:9,fontWeight:700,padding:'1px 5px',borderRadius:3,background:C.navyLight,color:C.navy,whiteSpace:'nowrap'}}>TRANSITION</span>}
        {col(item,'date')&&<span style={{fontSize:10,padding:'1px 6px',borderRadius:3,background:bc.bg,color:bc.text,border:`1px solid ${bc.border}`,whiteSpace:'nowrap'}}>{col(item,'date')}</span>}
        <span style={{fontSize:12,fontWeight:600,color:C.inkMid,whiteSpace:'nowrap'}}>{fmt(yd)} yds</span>
        {wip>0&&<span style={{fontSize:11,color:C.inkLight,whiteSpace:'nowrap'}}>{fmtD(wip)}</span>}
        <span style={{width:7,height:7,borderRadius:'50%',background:statusDot(status),flexShrink:0}}/>
        <span style={{fontSize:9,color:C.border}}>{open?'▲':'▼'}</span>
      </div>
      {open&&(
        <div style={{padding:'6px 16px 10px',display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:'4px 20px',background:C.cream}}>
          <Detail label="Order #" value={col(item,'text8')}/>
          <Detail label="PO #" value={col(item,'text0')}/>
          <Detail label="Customer" value={col(item,'text4')}/>
          <Detail label="ESD" value={col(item,'date')}/>
          <Detail label="Age Bucket" value={bucket} color={bc.text}/>
          {tp>0&&<Detail label="Yards to Print" value={fmt(tp)}/>}
          <Detail label="# Colors" value={col(item,'text6__1')}/>
          <Detail label="Operator" value={col(item,'status_1_mkmee286')}/>
          {wip>0&&<Detail label="WIP $" value={fmtD(wip)}/>}
          <Detail label="Status" value={status} color={statusDot(status)}/>
          <Detail label="Group" value={item.group?.title}/>
        </div>
      )}
    </div>
  )
}

function WIPDetailPanel({items}){
  const [deptF,setDeptF]=useState('All')
  const [bucketF,setBucketF]=useState('All')
  const [search,setSearch]=useState('')
  const [groupBy,setGroupBy]=useState('date')

  const depts=useMemo(()=>['All',...[...new Set(items.map(getDept))].sort()],[items])

  const filtered=useMemo(()=>items.filter(i=>{
    if(deptF!=='All'&&getDept(i)!==deptF) return false
    if(bucketF!=='All'&&getBucket(i)!==bucketF) return false
    if(search){
      const s=search.toLowerCase()
      if(!i.name.toLowerCase().includes(s)&&!col(i,'text8').includes(s)&&!col(i,'text4').toLowerCase().includes(s)) return false
    }
    return true
  }),[items,deptF,bucketF,search])

  const totalYds=filtered.reduce((s,i)=>s+yds(i),0)
  const totalWip=filtered.reduce((s,i)=>s+wipA(i),0)
  const totalToPrint=filtered.reduce((s,i)=>s+ytop(i),0)

  const byBucket=useMemo(()=>{
    const g={}; DATE_BUCKETS.forEach(b=>{g[b]=[]})
    filtered.forEach(i=>{const b=getBucket(i);if(g[b]!==undefined)g[b].push(i);else{if(!g['No Date'])g['No Date']=[];g['No Date'].push(i)}})
    return g
  },[filtered])

  const byDept=useMemo(()=>{
    const g={}
    filtered.forEach(i=>{const d=getDept(i);if(!g[d])g[d]=[];g[d].push(i)})
    return g
  },[filtered])

  const deptStats=useMemo(()=>{
    const s={}
    items.forEach(i=>{const d=getDept(i);if(!s[d])s[d]={count:0,yards:0,wip:0};s[d].count++;s[d].yards+=yds(i);s[d].wip+=wipA(i)})
    return Object.entries(s).sort((a,b)=>b[1].yards-a[1].yards)
  },[items])
  const maxYds=Math.max(...deptStats.map(([,v])=>v.yards),1)

  function BucketHeader({b,arr}){
    const bc=BUCKET_COLORS[b]
    const totalY=arr.reduce((s,i)=>s+yds(i),0)
    const totalW=arr.reduce((s,i)=>s+wipA(i),0)
    const totalP=arr.reduce((s,i)=>s+ytop(i),0)
    return (
      <div style={{padding:'7px 16px',background:bc.bg,borderBottom:`1px solid ${bc.border}`,display:'flex',alignItems:'center',gap:12,position:'sticky',top:0,zIndex:1}}>
        <span style={{fontSize:11,fontWeight:700,color:bc.text,textTransform:'uppercase',letterSpacing:'0.07em'}}>{b}</span>
        <span style={{fontSize:11,color:bc.text,opacity:0.8}}>{arr.length} orders</span>
        <span style={{fontSize:11,fontWeight:600,color:bc.text}}>{fmt(totalY)} yds ordered</span>
        {totalP>0&&<span style={{fontSize:11,color:bc.text,opacity:0.8}}>{fmt(totalP)} to print</span>}
        {totalW>0&&<span style={{fontSize:11,color:bc.text,opacity:0.8}}>{fmtD(totalW)} WIP</span>}
      </div>
    )
  }

  return (
    <div style={{background:'#fff',borderRadius:12,border:`1px solid ${C.border}`,overflow:'hidden'}}>
      {/* Dept bars */}
      <div style={{padding:'14px 20px',background:C.parchment,borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>
          {deptStats.map(([d,s])=>(
            <div key={d} style={{flex:1,minWidth:130}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:11,fontWeight:700,color:dc(d).text,textTransform:'uppercase',letterSpacing:'0.06em'}}>{d}</span>
                <span style={{fontSize:11,color:C.inkLight}}>{s.count} · {fmt(s.yards)} yds{s.wip>0?` · ${fmtD(s.wip)}`:''}</span>
              </div>
              <div style={{height:5,background:C.warm,borderRadius:99}}>
                <div style={{height:5,width:Math.round(s.yards/maxYds*100)+'%',background:dc(d).bar,borderRadius:99,transition:'width 0.6s'}}/>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div style={{padding:'10px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',background:'#fdfcfb'}}>
        <input placeholder="Search name, order #, customer…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{padding:'5px 10px',borderRadius:6,border:`1px solid ${C.border}`,fontSize:12,width:210,outline:'none',background:'#fff',color:C.ink}}/>

        <div style={{display:'flex',gap:3,alignItems:'center'}}>
          <span style={{fontSize:10,color:C.inkLight,textTransform:'uppercase',letterSpacing:'0.06em',marginRight:2}}>Dept:</span>
          {depts.map(d=>(
            <FilterBtn key={d} active={deptF===d} onClick={()=>setDeptF(d)} activeColor={dc(d).bar}>{d}</FilterBtn>
          ))}
        </div>

        <div style={{display:'flex',gap:3,alignItems:'center',flexWrap:'wrap'}}>
          <span style={{fontSize:10,color:C.inkLight,textTransform:'uppercase',letterSpacing:'0.06em',marginRight:2}}>Date:</span>
          <FilterBtn active={bucketF==='All'} onClick={()=>setBucketF('All')}>All</FilterBtn>
          {DATE_BUCKETS.map(b=>{
            const bc=BUCKET_COLORS[b]
            return <FilterBtn key={b} active={bucketF===b} onClick={()=>setBucketF(b)} activeColor={bc.text}>{b}</FilterBtn>
          })}
        </div>

        <div style={{marginLeft:'auto',display:'flex',gap:3}}>
          {[['date','By Date'],['dept','By Dept'],['flat','Flat']].map(([v,l])=>(
            <FilterBtn key={v} active={groupBy===v} onClick={()=>setGroupBy(v)}>{l}</FilterBtn>
          ))}
        </div>
      </div>

      {/* Totals bar */}
      <div style={{padding:'8px 16px',background:C.ink,display:'flex',gap:20,alignItems:'center'}}>
        <span style={{fontSize:11,fontWeight:700,color:C.goldLight,textTransform:'uppercase',letterSpacing:'0.06em'}}>Filtered totals</span>
        <span style={{fontSize:13,fontWeight:700,color:'#fff'}}>{fmt(filtered.length)} orders</span>
        <span style={{fontSize:13,fontWeight:700,color:C.goldLight}}>{fmt(totalYds)} yds ordered</span>
        {totalToPrint>0&&<span style={{fontSize:13,color:'#ccc'}}>{fmt(totalToPrint)} yds to print</span>}
        {totalWip>0&&<span style={{fontSize:13,color:'#ccc'}}>{fmtD(totalWip)} WIP value</span>}
      </div>

      {/* Order list */}
      <div style={{maxHeight:500,overflowY:'auto'}}>
        {filtered.length===0
          ? <div style={{padding:32,textAlign:'center',color:C.inkLight,fontSize:13}}>No orders match filter</div>
          : groupBy==='date'
          ? DATE_BUCKETS.map(b=>byBucket[b]?.length?(
            <div key={b}>
              <BucketHeader b={b} arr={byBucket[b]}/>
              {byBucket[b].map(i=><OrderRow key={i.id} item={i}/>)}
            </div>
          ):null)
          : groupBy==='dept'
          ? Object.entries(byDept).map(([d,ditems])=>(
            <div key={d}>
              <div style={{padding:'7px 16px',background:C.parchment,borderBottom:`1px solid ${C.border}`,display:'flex',gap:10,position:'sticky',top:0,zIndex:1}}>
                <span style={{fontSize:11,fontWeight:700,color:dc(d).text,textTransform:'uppercase',letterSpacing:'0.07em'}}>{d}</span>
                <span style={{fontSize:11,color:C.inkLight}}>{ditems.length} orders · {fmt(ditems.reduce((s,i)=>s+yds(i),0))} yds</span>
              </div>
              {ditems.map(i=><OrderRow key={i.id} item={i}/>)}
            </div>
          ))
          : filtered.map(i=><OrderRow key={i.id} item={i}/>)
        }
      </div>
    </div>
  )
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
function ScheduleRow({item}){
  const [open,setOpen]=useState(false)
  const d=getDept(item), status=col(item,'status5')
  const yd=yds(item), tp=ytop(item), wip=wipA(item)

  return (
    <div style={{borderBottom:`1px solid ${C.border}`,background:open?C.parchment:'transparent'}}>
      <div onClick={()=>setOpen(!open)} style={{display:'grid',gridTemplateColumns:'72px 1fr 88px 88px 60px 130px 100px',gap:0,padding:'8px 16px',cursor:'pointer',alignItems:'center'}}>
        <span style={{fontSize:9,fontWeight:700,padding:'2px 4px',borderRadius:3,background:dc(d).bg,color:dc(d).text,textAlign:'center',display:'inline-block'}}>{d.toUpperCase().slice(0,4)}</span>
        <div style={{minWidth:0,paddingRight:8}}>
          <div style={{fontSize:12,fontWeight:500,color:C.ink,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.name}</div>
          {col(item,'status_1__1')==='NEW GOODS'&&<span style={{fontSize:9,color:C.amber,fontWeight:700}}>NEW GOODS</span>}
        </div>
        <span style={{fontSize:12,color:C.inkMid}}>{fmt(yd)} yds</span>
        <span style={{fontSize:12,color:C.inkMid}}>{tp>0?fmt(tp)+' yds':'—'}</span>
        <span style={{fontSize:12,color:C.inkMid}}>{col(item,'text6__1')||'—'}</span>
        <span style={{fontSize:11,color:C.inkMid,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{col(item,'status_1_mkmee286')||'—'}</span>
        <div style={{display:'flex',alignItems:'center',gap:5}}>
          <span style={{width:7,height:7,borderRadius:'50%',background:statusDot(status),flexShrink:0}}/>
          <span style={{fontSize:10,color:C.inkMid,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{status}</span>
        </div>
      </div>
      {open&&(
        <div style={{padding:'6px 16px 10px',display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:'4px 20px',background:C.cream}}>
          <Detail label="Order #" value={col(item,'text8')}/>
          <Detail label="PO #" value={col(item,'text0')}/>
          <Detail label="Customer" value={col(item,'text4')}/>
          <Detail label="ESD" value={col(item,'date')}/>
          {wip>0&&<Detail label="WIP $" value={fmtD(wip)}/>}
          <Detail label="Shift" value={col(item,'shift_mkme25cp')}/>
          <Detail label="Status" value={status} color={statusDot(status)}/>
        </div>
      )}
    </div>
  )
}

function ScheduleDay({dayLabel,dateLabel,items}){
  const [collapsed,setCollapsed]=useState(false)
  if(!items.length) return null

  const complete=items.filter(i=>col(i,'status5').toUpperCase()==='COMPLETE').length
  const inProd=items.filter(i=>col(i,'status5').toUpperCase()==='IN PRODUCTION').length
  const approved=items.filter(i=>col(i,'status5').toUpperCase()==='APPROVED FOR PROD').length
  const totalYds=items.reduce((s,i)=>s+yds(i),0)
  // Yards to PRINT (ytop) — the key operational metric
  const totalToPrint=items.reduce((s,i)=>s+ytop(i),0)
  const deptCounts={}
  items.forEach(i=>{const d=getDept(i);deptCounts[d]=(deptCounts[d]||0)+1})

  return (
    <div style={{background:'#fff',borderRadius:12,border:`1px solid ${C.border}`,overflow:'hidden',marginBottom:12}}>
      {/* Day header */}
      <div onClick={()=>setCollapsed(!collapsed)} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 20px',background:C.ink,cursor:'pointer'}}>
        <div style={{minWidth:110}}>
          <div style={{fontSize:15,fontWeight:700,color:'#fff',fontFamily:'Georgia,serif'}}>{dayLabel}</div>
          <div style={{fontSize:11,color:C.goldLight,marginTop:1}}>{dateLabel}</div>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',flex:1,alignItems:'center'}}>
          <Pill label={`${items.length} orders`} bg="#ffffff15" text="#fff"/>
          <Pill label={`${fmt(totalYds)} yds ordered`} bg="#ffffff15" text="#ddd"/>
          {/* Yards to print — highlighted */}
          {totalToPrint>0&&<Pill label={`${fmt(totalToPrint)} yds to print`} bg={C.goldBg+'30'} text={C.goldLight}/>}
          <Pill label={`${complete} complete`} bg="#22c55e20" text="#86efac"/>
          {inProd>0&&<Pill label={`${inProd} in prod`} bg="#3b82f620" text="#93c5fd"/>}
          {approved>0&&<Pill label={`${approved} ready`} bg="#ffffff10" text={C.goldLight}/>}
          {Object.entries(deptCounts).map(([d,n])=>(
            <Pill key={d} label={`${d.slice(0,3)} ${n}`} bg="#ffffff10" text="#bbb"/>
          ))}
        </div>
        {/* Yards to print callout on far right */}
        {totalToPrint>0&&(
          <div style={{textAlign:'right',flexShrink:0,paddingLeft:12,borderLeft:'1px solid #ffffff20'}}>
            <div style={{fontSize:20,fontWeight:700,color:C.goldLight,fontFamily:'Georgia,serif',lineHeight:1}}>{fmt(totalToPrint)}</div>
            <div style={{fontSize:9,color:'#888',textTransform:'uppercase',letterSpacing:'0.08em'}}>yds to print</div>
          </div>
        )}
        <span style={{color:'#555',fontSize:11,marginLeft:8}}>{collapsed?'▼':'▲'}</span>
      </div>

      {/* Column headers */}
      {!collapsed&&(
        <div>
          <div style={{display:'grid',gridTemplateColumns:'72px 1fr 88px 88px 60px 130px 100px',gap:0,padding:'6px 16px',background:C.parchment,borderBottom:`1px solid ${C.border}`}}>
            {['Dept','Item','Ordered','To Print','Colors','Operator','Status'].map(h=>(
              <span key={h} style={{fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:C.inkLight}}>{h}</span>
            ))}
          </div>
          {items.map(item=><ScheduleRow key={item.id} item={item}/>)}
        </div>
      )}
    </div>
  )
}

// ─── Schedule Banner ──────────────────────────────────────────────────────────
function ScheduleBanner({schedDays}){
  const allItems=Object.values(schedDays).flatMap(d=>d.items)
  if(!allItems.length) return null

  const totalOrders=allItems.length
  const totalYds=allItems.reduce((s,i)=>s+yds(i),0)
  const totalToPrint=allItems.reduce((s,i)=>s+ytop(i),0)
  const complete=allItems.filter(i=>col(i,'status5').toUpperCase()==='COMPLETE').length
  const pctDone=totalOrders?Math.round(complete/totalOrders*100):0

  // By dept
  const byDept={}
  allItems.forEach(i=>{
    const d=getDept(i)
    if(!byDept[d])byDept[d]={count:0,yards:0,toPrint:0}
    byDept[d].count++; byDept[d].yards+=yds(i); byDept[d].toPrint+=ytop(i)
  })

  return (
    <div style={{background:C.ink,borderRadius:12,padding:'18px 24px',marginBottom:16,border:`1px solid #3a2e2a`}}>
      <div style={{display:'flex',alignItems:'flex-start',gap:24,flexWrap:'wrap'}}>
        {/* Main totals */}
        <div style={{flex:1,minWidth:200}}>
          <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:C.inkLight,marginBottom:8}}>This Week — Print Schedule</div>
          <div style={{display:'flex',gap:24,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:28,fontWeight:700,color:'#fff',fontFamily:'Georgia,serif',lineHeight:1}}>{fmt(totalOrders)}</div>
              <div style={{fontSize:11,color:C.inkLight,marginTop:2}}>orders scheduled</div>
            </div>
            <div>
              <div style={{fontSize:28,fontWeight:700,color:C.goldLight,fontFamily:'Georgia,serif',lineHeight:1}}>{fmt(totalToPrint)}</div>
              <div style={{fontSize:11,color:C.inkLight,marginTop:2}}>yards to print</div>
            </div>
            <div>
              <div style={{fontSize:28,fontWeight:700,color:'#86efac',fontFamily:'Georgia,serif',lineHeight:1}}>{pctDone}%</div>
              <div style={{fontSize:11,color:C.inkLight,marginTop:2}}>{complete} of {totalOrders} complete</div>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{height:4,background:'#ffffff15',borderRadius:99,marginTop:12}}>
            <div style={{height:4,width:pctDone+'%',background:'#86efac',borderRadius:99,transition:'width 0.6s'}}/>
          </div>
        </div>

        {/* By dept */}
        <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
          {Object.entries(byDept).sort((a,b)=>b[1].toPrint-a[1].toPrint).map(([d,s])=>{
            const dcc=dc(d)
            return (
              <div key={d} style={{background:'#ffffff08',borderRadius:8,padding:'10px 14px',border:`1px solid #ffffff15`,minWidth:120}}>
                <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:dcc.text,marginBottom:6}}>{d}</div>
                <div style={{fontSize:16,fontWeight:700,color:'#fff'}}>{s.toPrint>0?fmt(s.toPrint):fmt(s.yards)} yds</div>
                <div style={{fontSize:10,color:C.inkLight,marginTop:2}}>{s.count} orders{s.toPrint>0?' to print':''}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Summary Card ─────────────────────────────────────────────────────────────
function SummaryCard({id,label,items,sub,active,onClick}){
  const isActive=active===id
  const totalYds=items.reduce((s,i)=>s+yds(i),0)
  const totalWip=items.reduce((s,i)=>s+wipA(i),0)
  return (
    <div onClick={()=>onClick(id)} style={{flex:1,minWidth:160,cursor:'pointer',background:isActive?C.ink:'#fff',border:`1.5px solid ${isActive?C.ink:C.border}`,borderRadius:10,padding:'16px 18px',boxShadow:isActive?'0 4px 20px rgba(44,36,32,0.15)':'0 1px 4px rgba(0,0,0,0.04)',transition:'all 0.2s'}}>
      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:isActive?C.goldLight:C.inkLight,marginBottom:8}}>{label}</div>
      <div style={{fontSize:32,fontWeight:700,color:isActive?'#fff':C.ink,lineHeight:1,fontFamily:'Georgia,serif'}}>{fmt(items.length)}</div>
      <div style={{fontSize:11,color:isActive?'#aaa':C.inkLight,marginTop:3}}>orders</div>
      <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${isActive?'#ffffff20':C.border}`}}>
        <span style={{fontSize:13,fontWeight:600,color:isActive?C.goldLight:C.inkMid}}>{fmt(totalYds)} yds</span>
        {totalWip>0&&<span style={{fontSize:11,color:isActive?'#aaa':C.inkLight,marginLeft:8}}>{fmtD(totalWip)}</span>}
      </div>
      {sub&&<div style={{fontSize:10,color:isActive?'#888':C.inkLight,marginTop:4}}>{sub}</div>}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function WIPTab(){
  const [data,setData]=useState(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState(null)
  const [lastFetched,setLastFetched]=useState(null)
  const [activeCard,setActiveCard]=useState('WIP')
  const [view,setView]=useState('wip')

  async function load(){
    setLoading(true);setError(null)
    try{
      const items=await fetchAllItems()
      const buckets={SCHEDULE:[],HTI:[],POST:[],HOLD:[],NEW_GOODS:[],WIP:[]}
      items.forEach(i=>buckets[classify(i)].push(i))
      const groups={}
      buckets.SCHEDULE.forEach(item=>{
        const t=item.group?.title||''
        const dk=dayKey(t),dt=parseGrpDate(t)
        if(!dk||!dt) return
        if(!groups[t])groups[t]={day:dk,date:dt,title:t,items:[]}
        groups[t].items.push(item)
      })
      const today=new Date();today.setHours(0,0,0,0)
      const upcoming=Object.values(groups)
        .filter(g=>g.date>=new Date(today.getTime()-86400000))
        .sort((a,b)=>a.date-b.date)
      const schedDays={}
      upcoming.forEach(g=>{if(!schedDays[g.day])schedDays[g.day]=g})
      setData({buckets,schedDays,total:items.length})
      setLastFetched(new Date())
    }catch(e){setError(e.message)}
    setLoading(false)
  }

  const CARDS=[
    {id:'WIP',      label:'Active WIP',        sub:'Excl. New Goods & HTI'},
    {id:'HTI',      label:'Held to Invoice',    sub:'Complete · awaiting shipment'},
    {id:'NEW_GOODS',label:'New Goods',          sub:'In dev · not actionable'},
    {id:'POST',     label:'Post Production',    sub:'Freight & ship direct'},
  ]

  const getBucket_items = id => data?.buckets[id]||[]
  const activeItems=getBucket_items(activeCard)
  const activeTitle=CARDS.find(c=>c.id===activeCard)?.label||''
  const schedDays=data?.schedDays||{}
  const DAY_LABELS=[{key:'MON',label:'Monday'},{key:'TUE',label:'Tuesday'},{key:'WED',label:'Wednesday'},{key:'THURS',label:'Thursday'},{key:'FRI',label:'Friday'}]

  return (
    <div style={{background:C.cream,minHeight:'100vh',padding:'0 0 48px',fontFamily:'system-ui,-apple-system,sans-serif'}}>
      {/* Page header */}
      <div style={{padding:'20px 0 16px',marginBottom:20,borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
          <div>
            <h2 style={{fontSize:24,fontWeight:700,margin:0,color:C.ink,fontFamily:'Georgia,serif'}}>Production · WIP & Schedule</h2>
            <p style={{fontSize:13,color:C.inkLight,margin:'4px 0 0'}}>Paramount Handprints · Monday.com{data?.total?` · ${data.total} items`:''}</p>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            {lastFetched&&<span style={{fontSize:11,color:C.inkLight}}>Refreshed {lastFetched.toLocaleTimeString()}</span>}
            <button onClick={load} disabled={loading} style={{padding:'9px 20px',background:loading?C.warm:C.ink,color:loading?C.inkLight:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:loading?'not-allowed':'pointer'}}>
              {loading?'Loading…':data?'↻ Refresh':'Load Data'}
            </button>
          </div>
        </div>
      </div>

      {error&&<div style={{background:C.roseBg,border:`1px solid #E8A0A0`,borderRadius:8,padding:'12px 16px',color:C.rose,fontSize:13,marginBottom:16}}>{error}</div>}

      {!data&&!loading&&(
        <div style={{textAlign:'center',padding:'80px 20px'}}>
          <div style={{fontSize:48,marginBottom:16,opacity:0.2}}>⚑</div>
          <div style={{fontSize:18,fontWeight:600,color:C.inkMid,fontFamily:'Georgia,serif',marginBottom:8}}>No data loaded</div>
          <div style={{fontSize:13,color:C.inkLight}}>Click "Load Data" to pull live from Monday.com</div>
        </div>
      )}
      {loading&&<div style={{textAlign:'center',padding:'80px 20px',color:C.inkLight,fontSize:14}}>Fetching from Monday.com…</div>}

      {data&&(
        <>
          {/* View toggle */}
          <div style={{display:'flex',gap:4,marginBottom:20}}>
            {[{v:'wip',l:'WIP & Backlog'},{v:'schedule',l:'Weekly Schedule'}].map(({v,l})=>(
              <button key={v} onClick={()=>setView(v)}
                style={{padding:'8px 20px',fontSize:13,fontWeight:view===v?700:400,borderRadius:8,cursor:'pointer',border:`1.5px solid ${view===v?C.ink:C.border}`,background:view===v?C.ink:'transparent',color:view===v?'#fff':C.inkMid}}>
                {l}
              </button>
            ))}
          </div>

          {/* WIP VIEW */}
          {view==='wip'&&(
            <>
              <div style={{display:'flex',gap:10,marginBottom:20,flexWrap:'wrap'}}>
                {CARDS.map(c=>(
                  <SummaryCard key={c.id} id={c.id} label={c.label} items={getBucket_items(c.id)} sub={c.sub} active={activeCard} onClick={setActiveCard}/>
                ))}
              </div>
              <BucketChart items={activeItems}/>
              <div style={{marginBottom:8,display:'flex',alignItems:'center',gap:8}}>
                <h3 style={{fontSize:14,fontWeight:700,color:C.ink,margin:0,textTransform:'uppercase',letterSpacing:'0.06em'}}>{activeTitle}</h3>
                <span style={{fontSize:12,color:C.inkLight}}>— {activeItems.length} orders · {fmt(activeItems.reduce((s,i)=>s+yds(i),0))} yds</span>
              </div>
              <WIPDetailPanel items={activeItems} title={activeTitle}/>
            </>
          )}

          {/* SCHEDULE VIEW */}
          {view==='schedule'&&(
            <div>
              <ScheduleBanner schedDays={schedDays}/>
              {DAY_LABELS.map(({key,label})=>{
                const d=schedDays[key]
                return <ScheduleDay key={key} dayLabel={label} dateLabel={d?.title||''} items={d?.items||[]}/>
              })}
              {!Object.keys(schedDays).length&&<div style={{textAlign:'center',padding:40,color:C.inkLight}}>No scheduled items found for upcoming week</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
