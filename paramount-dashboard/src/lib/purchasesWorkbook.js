// Parser for Jen's multi-tab GP Purchases / AR / AP / CapEx workbook.
// Browser usage: parsePurchasesWorkbook(window.XLSX, workbook, { fileName })
// Returns { transactions:[], aging:[], summary:{}, asOfDate, fileName, warnings:[] }
import { FISCAL_CALENDAR } from '../fiscalCalendar';

const MONTH_NUM = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

// ---- date helpers ----------------------------------------------------------
function toISO(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),da=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${da}`}
function cellToISO(v){
  if(v==null||v==='')return null;
  if(v instanceof Date)return toISO(v);
  if(typeof v==='number'){ // Excel serial
    const d=new Date(Math.round((v-25569)*86400000)); return toISO(new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),12));
  }
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(m){let yr=+m[3]; if(yr<100)yr+=2000; return `${yr}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`}
  const d=new Date(s); return isNaN(d.getTime())?null:toISO(d);
}
// Map any calendar date to its fiscal week/month. Weeks are Sunday->Saturday,
// where Sunday = (Monday calendar key - 1 day). This matches the app's
// Sunday anchoring while reusing the Monday-keyed FISCAL_CALENDAR.
const _weeks = Object.entries(FISCAL_CALENDAR).map(([mondayKey,info])=>{
  const mon=new Date(mondayKey+'T12:00:00');
  const sun=new Date(mon); sun.setDate(sun.getDate()-1);
  const sat=new Date(mon); sat.setDate(sat.getDate()+5);
  return {mondayKey,info,sun,sat};
}).sort((a,b)=>a.sun-b.sun);
function fiscalForDate(iso){
  if(!iso)return {};
  const t=new Date(iso+'T12:00:00');
  for(const w of _weeks){ if(t>=w.sun&&t<=w.sat){
    const yr=w.mondayKey.slice(0,4);
    return { fiscal_year:yr, fiscal_month:`${yr}-${MONTH_NUM[w.info.month]}`, fiscal_week:w.info.weekInMonth, fiscal_week_key:w.mondayKey, quarter:w.info.quarter };
  }}
  return {};
}

// ---- generic helpers -------------------------------------------------------
const norm = s => String(s||'').toLowerCase().replace(/[\s_]+/g,'');
function colIndex(headerRow, ...names){
  const H=headerRow.map(norm);
  for(const n of names){ const k=norm(n); const i=H.indexOf(k); if(i>=0)return i; }
  // loose contains fallback
  for(const n of names){ const k=norm(n); const i=H.findIndex(h=>h.includes(k)); if(i>=0)return i; }
  return -1;
}
function num(v){ if(v==null||v==='')return 0; const n=parseFloat(String(v).replace(/[, $]/g,'')); return isNaN(n)?0:n; }
function buFromAccount(acct){
  const p=String(acct||'').split('-')[0].trim();
  return p==='609'?'BNY':p==='610'?'NJ':p==='612'?'Shared':null;
}

// ---- category mapping (tab + account code) ---------------------------------
function categoryFor(tab, code){
  const c=String(code||'');
  if(tab==='inventory_ink_freight'){
    if(c==='1437')return 'material_inventory';
    if(c==='6312')return 'ink';
    if(c==='6430')return 'freight';
    return 'inventory_other';
  }
  if(tab==='opex_te'){
    if(c==='6125')return 'opex_temp';
    if(['6205','6210','6220','6221','6255','6260','6270','6271'].includes(c))return 'opex_te';
    if(['6405','6410','6415','6420','6430','6435'].includes(c))return 'opex_distribution';
    if(['6505','6510','6515','6520','6525','6550','6815'].includes(c))return 'opex_edp';
    if(['6530','6540'].includes(c))return 'opex_supplies';
    if(c==='6312')return 'opex_printing';
    if(c==='6630'||c==='6640')return 'opex_services';
    if(c==='6710'||c==='6715')return 'opex_utilities';
    if(['6740','6745'].includes(c))return 'opex_rent';
    if(c==='1515')return 'prepaid';
    if(c==='4815')return 'line_dev';
    return 'opex_other';
  }
  if(tab==='sales_ar_invoiced') return c==='1212'?'ar_adjustment':'ar_trade';
  if(tab==='ar_received')       return 'ar_receipt';
  if(tab==='ap_invoiced')       return 'ap_invoiced';
  if(tab==='ap_paid')           return 'ap_paid';
  if(tab==='capex')             return 'capex';
  return 'other';
}

// ---- tab name -> source_tab key --------------------------------------------
const TAB_MAP=[
  [/inventory.*ink.*freight/i,'inventory_ink_freight'],
  [/sales.*ar.*invoiced|ar.*invoiced/i,'sales_ar_invoiced'],
  [/ar.*received/i,'ar_received'],
  [/ap.*invoiced/i,'ap_invoiced'],
  [/ap.*paid/i,'ap_paid'],
  [/opex.*t.*e|opex/i,'opex_te'],
  [/capex/i,'capex'],
];
function tabKey(name){ for(const [re,key] of TAB_MAP){ if(re.test(name))return key; } return null; }

// ---- transactional tab parser ----------------------------------------------
function parseTxnSheet(XLSX, sheet, srcTab, fileName){
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:true});
  if(!rows.length)return [];
  const hdr=rows[0];
  const cObj=colIndex(hdr,'Object','Main Account Segment');
  const cDate=colIndex(hdr,'TRX Date','Document Date');
  const cPid=colIndex(hdr,'Period ID');
  const cDeb=colIndex(hdr,'Debit Amount');
  const cCred=colIndex(hdr,'Credit Amount');
  const cNet=colIndex(hdr,'NET','Net');
  const cAcct=colIndex(hdr,'Account Number');
  const cAdesc=colIndex(hdr,'Account Description');
  const cDesc=colIndex(hdr,'Description');
  const cRef=colIndex(hdr,'Reference');
  const cMaster=colIndex(hdr,'Originating Master Name','Master Name');
  const cDoc=colIndex(hdr,'Originating Document Number','Document Number');
  const cVoid=colIndex(hdr,'Voided');
  const out=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i]; if(!r||r[cObj]==null)continue;
    const acct=cAcct>=0?String(r[cAcct]||''):'';
    const code=cObj>=0?String(r[cObj]).trim():'';
    const iso=cellToISO(cDate>=0?r[cDate]:null);
    const fis=fiscalForDate(iso);
    out.push({
      source_tab:srcTab,
      category:categoryFor(srcTab,code),
      trx_date:iso,
      period_id:cPid>=0?(num(r[cPid])||null):null,
      fiscal_year:fis.fiscal_year||null,
      fiscal_month:fis.fiscal_month||null,
      fiscal_week:fis.fiscal_week||null,
      account_number:acct||null,
      business_unit:buFromAccount(acct),
      account_code:code||null,
      account_description:cAdesc>=0?(r[cAdesc]||null):null,
      debit:num(cDeb>=0?r[cDeb]:0),
      credit:num(cCred>=0?r[cCred]:0),
      net:num(cNet>=0?r[cNet]:0),
      description:cDesc>=0?(r[cDesc]||null):null,
      reference:cRef>=0?(r[cRef]||null):null,
      master_name:cMaster>=0?(r[cMaster]||null):null,
      document_number:cDoc>=0?String(r[cDoc]||'')||null:null,
      voided:cVoid>=0?String(r[cVoid]||'').toLowerCase()==='yes':false,
      source_file:fileName||null,
    });
  }
  return out;
}

// ---- aging parsers ---------------------------------------------------------
function findHeaderRow(rows, ...must){
  for(let i=0;i<Math.min(rows.length,6);i++){
    const H=(rows[i]||[]).map(norm);
    if(must.every(m=>H.some(h=>h.includes(norm(m)))))return i;
  }
  return -1;
}
function parseAR(XLSX, sheet, asOf, fileName){
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:true});
  const hi=findHeaderRow(rows,'customer name','current'); if(hi<0)return [];
  const hdr=rows[hi];
  const cName=colIndex(hdr,'Customer Name'), cId=colIndex(hdr,'Customer ID');
  const cDoc=colIndex(hdr,'Document Number'), cDdate=colIndex(hdr,'Document Date'), cDue=colIndex(hdr,'Due Date'), cTerms=colIndex(hdr,'Terms');
  const cUnap=colIndex(hdr,'Unapplied Amount','Unapplied');
  const cCur=colIndex(hdr,'Current'), c1=colIndex(hdr,'1 to 7 Days'), c8=colIndex(hdr,'8 to 30 Days'),
        c31=colIndex(hdr,'31 to 60 Days'), c61=colIndex(hdr,'61 to 90 Days'), c91=colIndex(hdr,'91 and Over');
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]; if(!r||!r[cName])continue;
    const bal=num(r[cUnap]);  // signed: credits are real negatives that net (matches report total)
    if(bal===0)continue;
    const cur=num(r[cCur]),b1=num(r[c1]),b8=num(r[c8]),b31=num(r[c31]),b61=num(r[c61]),b91=num(r[c91]);
    out.push({ as_of_date:asOf, aging_type:'ar', business_unit:'combined',
      party_id:cId>=0?(r[cId]||null):null, party_name:String(r[cName]).trim(),
      document_number:cDoc>=0?String(r[cDoc]||'')||null:null,
      document_date:cellToISO(cDdate>=0?r[cDdate]:null), due_date:cellToISO(cDue>=0?r[cDue]:null),
      terms:cTerms>=0?(r[cTerms]||null):null,
      balance:bal, past_due:b1+b8+b31+b61+b91,
      buckets:{current:cur,d1_7:b1,d8_30:b8,d31_60:b31,d61_90:b61,d91plus:b91},
      source_file:fileName||null });
  }
  return out;
}
function parseAP(XLSX, sheet, asOf, fileName){
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null,raw:true});
  const hi=findHeaderRow(rows,'vendor name','balance'); if(hi<0)return [];
  const hdr=rows[hi];
  const cName=colIndex(hdr,'Vendor Name'), cId=colIndex(hdr,'Vendor ID'), cTerms=colIndex(hdr,'Vendor Terms','Terms');
  const cDiv=colIndex(hdr,'Division'), cBal=colIndex(hdr,'Balance');
  const cCur=colIndex(hdr,'Current'), c1=colIndex(hdr,'1 to 7 days','1 to 7 Days'),
        c8=colIndex(hdr,'8 to 14 Days'), c15=colIndex(hdr,'15 to 30 days','15 to 30 Days'),
        c31=colIndex(hdr,'31 to 45 Days'), c45=colIndex(hdr,'45 and over');
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]; if(!r||!r[cName])continue;
    const bal=num(r[cBal]); if(bal===0)continue;
    const div=String(r[cDiv]||'').trim().toUpperCase();
    const bu=div==='BNY'?'BNY':div==='PH'?'NJ':div.includes('PARA')?'NJ':null;
    const cur=num(r[cCur]),b1=num(r[c1]),b8=num(r[c8]),b15=num(r[c15]),b31=num(r[c31]),b45=num(r[c45]);
    out.push({ as_of_date:asOf, aging_type:'ap', business_unit:bu,
      party_id:cId>=0?(r[cId]||null):null, party_name:String(r[cName]).trim(),
      document_number:null, document_date:null, due_date:null, terms:cTerms>=0?(r[cTerms]||null):null,
      balance:bal, past_due:b1+b8+b15+b31+b45,
      buckets:{current:cur,d1_7:b1,d8_14:b8,d15_30:b15,d31_45:b31,d45plus:b45},
      source_file:fileName||null });
  }
  return out;
}

// ---- as-of date from filename (e.g. "...as_of_6_25_26") ---------------------
function asOfFromName(fileName){
  if(!fileName)return null;
  const m=String(fileName).match(/as[_\s-]*of[_\s-]*(\d{1,2})[_\-\/](\d{1,2})[_\-\/](\d{2,4})/i);
  if(!m)return null;
  let yr=+m[3]; if(yr<100)yr+=2000;
  return `${yr}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
}

// ---- main ------------------------------------------------------------------
export function parsePurchasesWorkbook(XLSX, workbook, opts={}){
  const fileName=opts.fileName||null;
  const warnings=[];
  let transactions=[], aging=[];
  for(const name of workbook.SheetNames){
    const key=tabKey(name);
    const sheet=workbook.Sheets[name];
    if(key){ transactions=transactions.concat(parseTxnSheet(XLSX,sheet,key,fileName)); }
  }
  // as-of date: filename, else max trx date
  let asOf=asOfFromName(fileName) || opts.asOf || null;
  if(!asOf && transactions.length){ asOf=transactions.map(t=>t.trx_date).filter(Boolean).sort().slice(-1)[0]||null; }
  // aging tabs
  for(const name of workbook.SheetNames){
    if(/ar\s*aging/i.test(name)) aging=aging.concat(parseAR(XLSX,workbook.Sheets[name],asOf,fileName));
    else if(/ap\s*aging/i.test(name)) aging=aging.concat(parseAP(XLSX,workbook.Sheets[name],asOf,fileName));
  }
  // summary
  const sumBy=(arr,keyFn)=>arr.reduce((m,t)=>{const k=keyFn(t);m[k]=(m[k]||0)+t.net;return m;},{});
  const fiscalMonths=[...new Set(transactions.map(t=>t.fiscal_month).filter(Boolean))].sort();
  const summary={
    txnCount:transactions.length,
    agingCount:aging.length,
    asOf,
    fiscalMonths,
    netByTab:sumBy(transactions,t=>t.source_tab),
    netByBU:sumBy(transactions,t=>t.business_unit||'?'),
    netByCategory:sumBy(transactions,t=>t.category),
    arAgingTotal:aging.filter(a=>a.aging_type==='ar').reduce((s,a)=>s+a.balance,0),
    apAgingTotal:aging.filter(a=>a.aging_type==='ap').reduce((s,a)=>s+a.balance,0),
  };
  if(!transactions.length)warnings.push('No transactional rows parsed');
  return { transactions, aging, summary, asOfDate:asOf, fileName, warnings };
}
