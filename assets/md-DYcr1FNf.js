import{E as e,H as t,R as n,S as r,X as i,_ as a,_t as o,g as s,gt as c,ht as l,j as u,x as d}from"./modules/shiki-DGiPhpB1.js";import{et as f,gt as p,tt as m}from"./index-9VQbxXui.js";import{t as h}from"./two-cols-Wi6cM2lO.js";var g={class:`algo-steps`},_=p({__name:`slides.md__slidev_13`,setup(p){let{$slidev:_,$nav:v,$clicksContext:y,$clicks:b,$page:x,$renderContext:S,$frontmatter:C}=m();return y.setup(),(p,m)=>{let _=t(`CodeBlockWrapper`);return n(),a(h,o(e(l(f)(l(C),12))),{right:i(e=>[m[8]||=s(`p`,{class:`algo-note`},`全局状态：等待队列Q； TTL 映射P（记录被pin住的程序及其TTL）；历史tool call记录S，其中S[ f ]表示tool f 的已记录tool call信息`,-1),s(`div`,g,[s(`div`,{class:c([`algo-step`,{active:l(b)===1}])},[...m[1]||=[s(`span`,{class:`ln`},`4–5`,-1),s(`div`,null,[s(`b`,null,`记录耗时`),d(`：下一轮到达时才把 t 记入 S[f]，t 是服务端测的相邻请求间隔`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===2}])},[...m[2]||=[s(`span`,{class:`ln`},`10–12`,-1),s(`div`,null,[s(`b`,null,`按下一个工具算 TTL`),d(`：r 的输出就是那次 function call，结束时已知 f`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===3}])},[...m[3]||=[s(`span`,{class:`ln`},`15–18`,-1),s(`div`,null,[s(`b`,null,`惰性过期`),d(`：没有定时器，只在 Schedule 里检查`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===4}])},[...m[4]||=[s(`span`,{class:`ln`},`16`,-1),s(`div`,null,[s(`b`,null,`过期且不在队列才释放`),d(`：下一轮已到、还在排队的，超时也不放`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===5}])},[...m[5]||=[s(`span`,{class:`ln`},`19`,-1),s(`div`,null,[s(`b`,null,`优先级`),d(`：见下页三级排序`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===6}])},[...m[6]||=[s(`span`,{class:`ln`},`20–21`,-1),s(`div`,null,[s(`b`,null,`放不下就 break`),d(`：不回填，严格保序；死锁靠驱逐规则兜底`)],-1)]],2),s(`div`,{class:c([`algo-step`,{active:l(b)===7}])},[...m[7]||=[s(`span`,{class:`ln`},`26`,-1),s(`div`,null,[s(`b`,null,`调度即 unpin`),d(`：TTL 只覆盖工具空窗`)],-1)]],2)])]),default:i(()=>[m[9]||=s(`h1`,null,`Algorithm 1：调度主循环`,-1),r(_,u({lines:!0},{title:``,ranges:[`all`,`4-5`,`10-12`,`15-18`,`16`,`19`,`20-21`,`26`]}),{default:i(()=>[...m[0]||=[s(`pre`,{class:`shiki shiki-themes vitesse-dark vitesse-light slidev-code`,style:{"--shiki-dark":`#dbd7caee`,"--shiki-light":`#393a34`,"--shiki-dark-bg":`#121212`,"--shiki-light-bg":`#ffffff`}},[s(`code`,{class:`language-text`},[s(`span`,{class:`line`},[s(`span`,null,`Function OnRequestArrive(r):`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`  Q ← Q ∪ {r};  id ← program ID of r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`  if id is a seen program then`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    (f, t) ← tool-call info from r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    S[f] ← S[f] ∪ {t}`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`Function OnRequestFinish(r):`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`  if r is the last request of its program then`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    free KV cache used by r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`  else`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    f  ← next tool to be called after r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    id ← program ID of r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    P[id] ← CalcTTL(r, S[f])       ▷ 即 τ* 求解`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`Function Schedule():`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`  while Q is not empty do`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    for each id in P.keys do`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      if now > P[id] and id ∉ Q.programs then`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`        free KV cache used by id's last request`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`        P ← P \\ {id}`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    r ← argmax_{r'∈Q} CalcPriority(r', P)`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    if r cannot fit into memory then`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      break`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`    else`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      Q ← Q \\ {r}`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      issue r to running`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      id ← program ID of r`)]),d(`
`),s(`span`,{class:`line`},[s(`span`,null,`      if id ∈ P.keys then P ← P \\ {id}`)])])],-1)]]),_:1},16)]),_:1},16)}}},[[`__scopeId`,`data-v-a93b1128`]]);export{_ as default};