#!/usr/bin/env python3
"""Fall Club Pickup Weekend report for Spruce Hill Winery (Gig Harbor).

Usage:
  python3 -I pickup_report.py reservations.json orders.json OUT.pdf "Nov 12, 2026" [prev_summary.json]

reservations.json : raw output of C7 Hookup get_reservations (from_date..to_date)
orders.json       : raw output of C7 Hookup get_orders (channel=Club, fulfillment_status=Not Fulfilled, limit=200)
Writes OUT.pdf and OUT.summary.json (bottle totals etc.). If prev_summary.json is given, a
"changes since last report" section is added. Requires reportlab.
"""
import json, sys, re
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

def load(p):
    raw=open(p,encoding='utf-8').read(); return json.loads(raw[raw.index('{'):])
res_file, ord_file, OUT, PREPARED = sys.argv[1:5]
PREV = json.load(open(sys.argv[5])) if len(sys.argv)>5 else None
resos=load(res_file)['reservations']; orders=load(ord_file)['orders']
resos=[r for r in resos if r.get('status') not in ('Cancelled','No Show')]
byc=defaultdict(list)
for o in orders: byc[o['customer_id']].append(o)

def pac(iso):  # UTC iso -> aware Pacific datetime (PST in Nov)
    return datetime.fromisoformat(iso.replace('Z','+00:00')).astimezone(timezone(timedelta(hours=-8)))
def wine_btl(o): return sum(i['qty'] for i in o['items'] if i['type']=='Wine')

ss=getSampleStyleSheet(); green=colors.HexColor('#2f4f3a'); light=colors.HexColor('#eef3ef')
H1=ParagraphStyle('h1',parent=ss['Title'],fontSize=18,spaceAfter=4,alignment=0)
H2=ParagraphStyle('h2',parent=ss['Heading2'],fontSize=12,spaceBefore=9,spaceAfter=4,textColor=green)
N=ParagraphStyle('n',parent=ss['Normal'],fontSize=9.5,leading=12)
Sm=ParagraphStyle('sm',parent=N,fontSize=8.5,leading=10.5)
B=ParagraphStyle('b',parent=N,fontSize=9,leading=11,leftIndent=10,bulletIndent=0,spaceAfter=1)
def tbl(data,widths,align_right=(),bold_last=False):
    t=Table(data,colWidths=widths,repeatRows=1)
    st=[('FONT',(0,0),(-1,-1),'Helvetica',9),('BOTTOMPADDING',(0,0),(-1,-1),3),('TOPPADDING',(0,0),(-1,-1),3),
        ('LINEBELOW',(0,-1),(-1,-1),0.5,colors.grey),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('BACKGROUND',(0,0),(-1,0),green),('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONT',(0,0),(-1,0),'Helvetica-Bold',9),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,light])]
    for c in align_right: st.append(('ALIGN',(c,0),(c,-1),'RIGHT'))
    if bold_last: st.append(('FONT',(0,-1),(-1,-1),'Helvetica-Bold',9))
    t.setStyle(TableStyle(st)); return t

wine=Counter(); perday={}; rows=defaultdict(list); total=0; flags=[]; slots=Counter(); seen_orders=set(); per_member={}
days=[]
for r in sorted(resos,key=lambda r:r['date']):
    dt=pac(r['date']); dkey=dt.strftime('%Y-%m-%d'); dlabel=dt.strftime('%A, %b %-d'); short=dt.strftime('%a'); time=dt.strftime('%-I:%M')
    if dkey not in perday: perday[dkey]=[dlabel,0,0,0]; days.append(dkey)
    perday[dkey][1]+=1; perday[dkey][2]+=r.get('guest_count') or 0; slots[f"{dlabel} {time} PM"]+=1
    name=r['customer'] or '(no name)'; g=str(r.get('guest_count') or ''); note=r.get('notes','').strip()
    is_pickup='Pickup' in (r.get('experience') or '') or 'Club' in (r.get('experience') or '')
    os_=byc.get(r.get('customer_id'),[])
    if not is_pickup:
        rows[dkey].append([time,name,g,'--','0',Paragraph(f"<b>{r.get('experience') or 'Reservation'}</b> (not a club pickup){', '+note if note else ''}",Sm)])
        flags.append(f"{name} ({short} {time} PM): {r.get('experience')} for {g}, not a club pickup."); continue
    if not os_:
        rows[dkey].append([time,name,g,'--','0',Paragraph("<b>NO UNFULFILLED CLUB ORDER.</b> Check C7."+(f" Note: {note}" if note else ""),Sm)])
        flags.append(f"{name} ({short} {time} PM): no unfulfilled club order found. Card declined, skipped, already picked up, or under another account?"); continue
    mb=0
    for o in os_:
        seen_orders.add(o['order_number']); b=wine_btl(o); total+=b; mb+=b; perday[dkey][3]+=b
        for i in o['items']:
            if i['type']=='Wine': wine[i['title']]+=i['qty']
        it=", ".join(f"{i['qty']}x {i['title']}" for i in o['items'])
        old=o['date_pacific']<'2026-10-01'
        tag=" <b>(older release, still unclaimed)</b>" if old else ""
        rows[dkey].append([time,name,g,str(o['order_number']),str(b),Paragraph(it+tag+(f"<br/><b>Note:</b> {note}" if note and not old else ""),Sm)])
    per_member[name]=mb
    if len(os_)>1: flags.append(f"{name} ({short} {time} PM): {len(os_)} unfulfilled orders to hand over ({', '.join(str(o['order_number']) for o in os_)}).")
    elif mb>12: flags.append(f"{name} ({short} {time} PM): customized order, {mb} bottles.")
    if note and not any(k in note.lower() for k in ('restriction',)): flags.append(f"{name} ({short} {time} PM) note: {note}")

rids={r.get('customer_id') for r in resos}
others=[o for o in orders if o['customer_id'] not in rids and o['delivery_method']=='Pickup']
ob=sum(wine_btl(o) for o in others); oldn=sum(1 for o in others if o['date_pacific']<'2026-10-01')
nres=sum(v[1] for v in perday.values()); ng=sum(v[2] for v in perday.values())
top=slots.most_common(1)[0] if slots else ("",0)
big=[n for n,b in per_member.items() if b==12]
if big: flags.append("12-bottle pickups: "+", ".join(big)+".")
flags.append(f"Beyond this weekend: {len(others)} more unfulfilled pickup orders ({ob} bottles) from members without a reservation, {oldn} of them from an older release.")

summary={"prepared":PREPARED,"reservations":nres,"guests":ng,"bottles":total,"by_wine":dict(wine),"per_member":per_member,"others":len(others),"other_bottles":ob,
         "members":sorted({r['customer'] for r in resos})}
changes=[]
if PREV:
    new=set(summary['members'])-set(PREV.get('members',[])); gone=set(PREV.get('members',[]))-set(summary['members'])
    if new: changes.append("New reservations: "+", ".join(sorted(new))+".")
    if gone: changes.append("Dropped reservations: "+", ".join(sorted(gone))+".")
    for m,b in per_member.items():
        pb=PREV.get('per_member',{}).get(m)
        if pb is not None and pb!=b: changes.append(f"{m}: {pb} -> {b} bottles.")
        if pb is None and m in PREV.get('members',[]) and b: changes.append(f"{m}: club order now processed ({b} bottles).")
    changes.append(f"Total bottles: {PREV.get('bottles')} -> {total}. Reservations: {PREV.get('reservations')} -> {nres}.")

story=[Paragraph("Spruce Hill Winery",ParagraphStyle('x',parent=N,textColor=green,fontSize=10)),
 Paragraph("Fall Wine Club Pickup Weekend: Gig Harbor",H1),
 Paragraph(f"{perday[days[0]][0]} through {perday[days[-1]][0]}, 2026. Prepared {PREPARED} from Commerce7 reservations and unfulfilled Club pickup orders.",Sm),Spacer(1,6)]
sd=[["Day","Resos","Guests","Bottles"]]+[[v[0],str(v[1]),str(v[2]),str(v[3])] for v in perday.values()]+[["Total",str(nres),str(ng),str(total)]]
wd=[["Wine","Bottles","Cases"]]+[[k,str(v),f"{v/12:.2f}"] for k,v in wine.most_common()]+[["Total",str(total),f"{total/12:.2f}"]]
left=[Paragraph("Summary",H2),tbl(sd,[1.3*inch,0.5*inch,0.55*inch,0.6*inch],(1,2,3),True),Spacer(1,6),
      Paragraph(f"<b>Stage {total} bottles ({total/12:.2f} cases) at Gig Harbor.</b> Busiest slot: {top[0]} with {top[1]} parties.",N)]
right=[Paragraph("Pull List by Wine",H2),tbl(wd,[2.1*inch,0.6*inch,0.6*inch],(1,2),True)]
grid=Table([[left,right]],colWidths=[3.2*inch,3.6*inch]); grid.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(0,0),12)]))
story+=[grid]
if changes:
    story.append(Paragraph(f"Changes since {PREV.get('prepared')}",H2))
    for c in changes: story.append(Paragraph(c,B,bulletText="•"))
story.append(Paragraph("Flags for Staff",H2))
for f in flags: story.append(Paragraph(f,B,bulletText="•"))
story+=[PageBreak(),Paragraph("Reservation Detail",H1)]
for dkey in days:
    v=perday[dkey]
    story.append(KeepTogether([Paragraph(f"{v[0]}: {v[1]} reservations, {v[2]} guests, {v[3]} bottles",H2),
        tbl([["Time","Member","Guests","Order","Btl","Wine"]]+rows[dkey],[0.5*inch,1.4*inch,0.5*inch,0.5*inch,0.4*inch,3.7*inch],(2,3,4))]))
def footer(c,doc):
    c.setFont('Helvetica',7.5); c.setFillColor(colors.grey)
    c.drawString(0.75*inch,0.5*inch,f"Spruce Hill Winery | Fall Club Pickup Weekend, Gig Harbor | Source: Commerce7, {PREPARED}")
    c.drawRightString(letter[0]-0.75*inch,0.5*inch,f"Page {doc.page}")
SimpleDocTemplate(OUT,pagesize=letter,leftMargin=0.75*inch,rightMargin=0.75*inch,topMargin=0.7*inch,bottomMargin=0.8*inch,
    title="Fall Wine Club Pickup Weekend",author="Spruce Hill Winery").build(story,onFirstPage=footer,onLaterPages=footer)
json.dump(summary,open(OUT.replace('.pdf','')+'.summary.json','w'),indent=1)
# Plain-text email body
lines=[f"Fall Club Pickup Weekend, Gig Harbor. Prepared {PREPARED}.","",f"Stage {total} bottles ({total/12:.2f} cases). {nres} reservations, {ng} guests.",""]
lines+=[f"  {v[0]}: {v[1]} resos, {v[2]} guests, {v[3]} bottles" for v in perday.values()]
lines+=["","Pull list:"]+[f"  {k}: {v}" for k,v in wine.most_common()]
if changes: lines+=["",f"Changes since {PREV.get('prepared')}:"]+[f"  - {c}" for c in changes]
lines+=["","Flags:"]+[f"  - {f}" for f in flags]
open(OUT.replace('.pdf','')+'.email.txt','w').write("\n".join(lines))
print("\n".join(lines))
