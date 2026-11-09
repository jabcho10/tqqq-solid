import pickle, pandas as pd, numpy as np, sys, copy
sys.path.insert(0,'.')
from engine import *
from multiprocessing import Pool
SOXL_L,SOXX_L,QQQ_L,*_=pickle.load(open('long.pkl','rb')); wk=pickle.load(open('wk.pkl','rb'))
out,T,qd=pickle.load(open('tq.pkl','rb')); sig=pickle.load(open('sig.pkl','rb'))
SD={k:{d:bool(v) for d,v in s.items()} for k,s in sig.items() if s is not None}
def mk(sname,act):
  m=SD[sname]
  return lambda d,reg: (act if m.get(d,False) else {})
def mk_reg(sname):
  m=SD[sname]
  return lambda d,reg: ({'init_ratio':.20,'rsi_ratio':.10} if (m.get(d,False) and reg in ('저','초저')) else {})
BLK={'init':0,'rsi':0}; HALF={'init':.5,'add':.5,'rsi':.5}; EXIT={'exit':True,'init':0,'rsi':0}
F=[('0 기준(원본)',{}),
 ('1 QQQ<200일 신규금지',{'filt':mk('q200',BLK)}),
 ('2 QQQ<200일 비중½',{'filt':mk('q200',HALF)}),
 ('3 QQQ<200일 전량청산',{'filt':mk('q200',EXIT)}),
 ('4 QQQ<200일(±3%밴드) 신규금지',{'filt':mk('q200h',BLK)}),
 ('5 저평가&QQQ<200일→최소비중',{'filt':mk_reg('q200')}),
 ('6 QQQ 12M모멘텀<0 신규금지',{'filt':mk('qmom',BLK)}),
 ('7 QQQ 변동성상위20% 신규금지',{'filt':mk('qvol',BLK)}),
 ('8 노출상한 60%',{'max_exposure':.6}),
 ('9 계좌DD<-25% 비중½',{'dd_throttle':(-0.25,0.5)}),
 ('10 시장평가 끔(33%고정)',{'use_regime':False}),
 ('11 RSI엔진 끔',{'use_rsi':False}),
 ('12 메인엔진 끔(RSI만)',{'use_main':False}),
 ('13 SOXX<200일 신규금지',{'filt':mk('x200',BLK)}),
 ('14 SOXX 변동성상위20% 신규금지',{'filt':mk('xvol',BLK)}),
]
DS={'TQQQ':(T,qd,'1991-01-02','2026-08-11'),'TQQQ10':(T,qd,'2010-01-04','2026-08-11'),
    'SOXL':(SOXL_L*100,SOXX_L,'2001-08-01','2026-11-03'),'SOXL10':(SOXL_L*100,SOXX_L,'2010-01-04','2026-11-03')}
def job(a):
  fi,ds=a; name,over=F[fi]
  if ds.startswith('TQQQ') and fi in (13,14): return None
  p=copy.deepcopy(P); p.update(over)
  sl,sx,s,e=DS[ds]
  r=run(sl,sx,QQQ_L,s,e,cash0=1e6,p=p,wk=wk); st=stats(r)
  y=yearly(r)
  sub=None
  if ds in('TQQQ','SOXL'):
    w=1+r.W; m=r[(r.index>='2000-01-01')&(r.index<='2009-12-31')] 
    ww=1+m.W; sub=((ww.iloc[-1]/ww.iloc[0])**(365/(m.index[-1]-m.index[0]).days)-1,(ww/ww.cummax()-1).min())
  return (name,ds,st['CAGR'],st['MDD'],st['Calmar'],st['avg_cash'],sub)
if __name__=='__main__':
  jobs=[(i,d) for i in range(len(F)) for d in DS]
  with Pool(8) as pl: res=[x for x in pl.map(job,jobs) if x]
  pickle.dump(res,open('fres.pkl','wb'))
  df=pd.DataFrame(res,columns=['f','ds','CAGR','MDD','Calmar','cash','sub'])
  for ds in DS:
    g=df[df.ds==ds]; print('=====',ds)
    for _,r in g.iterrows():
      sub=f"  00~09: {r['sub'][0]:6.1%}/{r['sub'][1]:6.1%}" if r['sub'] else ''
      print(f"{r.f:30s} CAGR {r.CAGR:6.1%} MDD {r.MDD:6.1%} Calmar {r.Calmar:.2f} 현금 {r.cash:.0%}{sub}")
