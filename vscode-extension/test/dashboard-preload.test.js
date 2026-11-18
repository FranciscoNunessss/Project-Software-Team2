const test=require('node:test')
const assert=require('node:assert/strict')
const {installVscode,OPTIONS}=require('./helpers')
const {vscode}=installVscode({})
vscode.extensions={getExtension:()=>({packageJSON:{contributes:{commands:[],keybindings:[]}}})}
const {Dashboard}=require('../dist/dashboard')
const {ApiError}=require('../dist/backend')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function fixture(){
 let session
 const calls=[],posted=[],state={active:0,peak:0}
 const progress=require('./fixtures/progress-with-coaching.json')
 const responses={'/api/llm-options':OPTIONS,'/api/evaluations':{models:[]},'/api/llm-configs':[{id:'synthetic-model',label:'Synthetic',provider:'groq',model:'synthetic',enabled:true}],'/api/chats':[],'/api/context':{memory:[],content:'',saved_conversations:0},'/api/sessions?limit=20':[],'/api/progress/pending?limit=10':[]}
 for(const k of ['activity','dashboard','outcomes','learning','coaching'])responses['/api/progress/'+k]=progress[k]
 responses['/api/progress']=progress.progress
 const backend={auth:'token',url:'https://synthetic.example',managing:false,onDidChangeSession:fn=>{session=fn},api:async(route,method='GET')=>{
  calls.push({route,method,origin:backend.url});state.active++;state.peak=Math.max(state.peak,state.active)
  try{await delay(4);const v=responses[route];return typeof v==='function'?await v():v??{}}
  finally{state.active--}
 }}
 const analyser={results:new Map(),onDidAnalyse:()=>{}}
 const chat={current:undefined,list:()=>backend.api('/api/chats')}
 const dash=new Dashboard(backend,analyser,chat,{})
 const view={visible:true,webview:{postMessage:m=>posted.push(m)}}
 return{dash,backend,calls,posted,responses,state,view,session:()=>session()}
}

test('startup warms all tabs without a view, in the background, with Assistant first and at most three reads',async()=>{
 const f=fixture()
 await f.dash.preload()
 assert.deepEqual([...f.dash.tabData.keys()].sort(),['analyse','models','profile','progress','shortcuts'])
 assert.equal(f.posted.length,0,'warming must not navigate or publish a background tab')
 assert.equal(f.state.peak,3)
 assert.deepEqual(f.calls.slice(0,3).map(c=>c.route),['/api/llm-options','/api/evaluations','/api/chats'])
 assert.ok(f.calls.every(c=>c.method==='GET'))
 assert.equal(f.dash.tabData.get('progress').data.coaching.saved.report.summary,'Synthetic saved Educator summary.')
 assert.equal(f.dash.cache.configs.length,0,'background models must not replace the active action cache')
 f.dash.view=f.view
 const before=f.calls.length
 for(const tab of ['analyse','progress','profile','models','shortcuts'])await f.dash.handle({type:'tab',tab})
 assert.equal(f.calls.length,before,'the first visit reuses startup data')
 assert.equal(f.dash.cache.configs[0].id,'synthetic-model','cached Models restores its validated action data')
})

test('signed out or invalid backend means no preload requests',async()=>{
 const f=fixture()
 f.backend.auth='none';await f.dash.preload();assert.equal(f.calls.length,0)
 f.backend.auth='token';f.backend.urlProblem='Invalid address';await f.dash.preload();assert.equal(f.calls.length,0)
})

test('a warm-up failure is contained and the foreground can retry that tab',async()=>{
 const f=fixture()
 f.responses['/api/context']=()=>{throw new Error('temporarily offline')}
 await f.dash.preload()
 assert.equal(f.dash.tabData.has('profile'),false)
 assert.equal(f.dash.tabData.has('progress'),true)
 assert.equal(f.dash.tabData.has('models'),true)
 assert.equal(f.posted.length,0)
 f.responses['/api/context']={memory:[],content:'Recovered',saved_conversations:0}
 f.dash.view=f.view
 await f.dash.handle({type:'tab',tab:'profile'})
 assert.equal(f.posted.at(-1).preferences,'Recovered')
})

test('opening the Assistant during startup joins the running fetch; ready does not discard it',async()=>{
 const f=fixture(),gate=deferred()
 f.responses['/api/llm-options']=()=>gate.promise
 const warming=f.dash.preload()
 assert.equal(f.dash.preload(),warming)
 f.dash.view=f.view
 const opening=f.dash.handle({type:'ready'})
 await delay(8)
 assert.equal(f.calls.filter(c=>c.route==='/api/llm-options').length,1)
 assert.equal(f.posted[0].loading,true)
 gate.resolve(OPTIONS)
 await opening
 await warming
 assert.equal(f.calls.filter(c=>c.route==='/api/llm-options').length,2,'one Assistant request, one Models request, no duplicated navigation request')
 assert.ok(f.posted.filter(p=>p.type==='data'&&!p.loading).every(p=>p.tab==='analyse'))
})

test('an active tab gets a queued read slot before background work',async()=>{
 const f=fixture(),gates=[deferred(),deferred(),deferred()],order=[]
 f.dash.view=f.view
 f.dash.tab='models'
 const signal=new AbortController().signal
 const busy=gates.map(g=>f.dash.read(()=>g.promise,signal,()=>false))
 const background=f.dash.read(async()=>{order.push('background')},signal,()=>false)
 const foreground=f.dash.read(async()=>{order.push('foreground')},signal,()=>f.dash.tab==='models')
 gates[0].resolve()
 await foreground
 assert.equal(order[0],'foreground')
 gates[1].resolve();gates[2].resolve()
 await Promise.all([...busy,background])
 assert.equal(f.dash.reading,0)
})

test('the Assistant can appear while another startup tab is still waiting for its data',async()=>{
 const f=fixture(),gate=deferred()
 f.responses['/api/progress/activity']=()=>gate.promise
 let completed=false
 const warming=f.dash.preload().then(()=>{completed=true})
 await f.dash.tabContent('analyse')
 f.dash.view=f.view
 await f.dash.handle({type:'ready'})
 assert.equal(f.posted.at(-1).tab,'analyse')
 assert.equal(f.posted.at(-1).loading,undefined)
 assert.equal(completed,false)
 gate.resolve([])
 await warming
})

test('signing out cancels startup and prevents late snapshots from returning',async()=>{
 const f=fixture(),gate=deferred()
 f.responses['/api/llm-options']=()=>gate.promise
 const warming=f.dash.preload()
 await delay(8)
 f.dash.view=f.view
 f.backend.auth='none';f.session()
 gate.resolve(OPTIONS)
 await warming
 assert.equal(f.dash.tabData.size,0)
 assert.equal(f.dash.loadingTabs.size,0)
 assert.equal(f.posted.at(-1).signedOut,true)
 assert.equal(f.calls.some(c=>c.route==='/api/context'),false)
})

test('a rejected credential stops startup, clears all data and shows sign-in',async()=>{
 const f=fixture()
 f.dash.view=f.view
 f.responses['/api/llm-options']=()=>{throw new ApiError(401,'not_authenticated')}
 await f.dash.preload()
 assert.equal(f.dash.authRejected,true)
 assert.equal(f.dash.tabData.size,0)
 assert.equal(f.posted.at(-1).signedOut,true)
 assert.equal(f.calls.some(c=>c.route==='/api/context'),false)
})

test('changing backend cancels the old warm-up and fills snapshots only for the new origin',async()=>{
 const f=fixture(),gate=deferred()
 f.responses['/api/llm-options']=()=>gate.promise
 const old=f.dash.preload()
 await delay(8)
 f.backend.url='https://other.example'
 f.responses['/api/llm-options']=OPTIONS
 const fresh=f.dash.preload()
 gate.resolve(OPTIONS)
 await Promise.all([old,fresh])
 assert.equal(f.dash.tabData.size,5)
 assert.ok([...f.dash.tabData.values()].every(v=>v.key.includes('other.example')))
})

test('disposal aborts warm-up even if no webview has been created',async()=>{
 const f=fixture(),gate=deferred()
 f.responses['/api/llm-options']=()=>gate.promise
 const warming=f.dash.preload()
 await delay(8)
 f.dash.dispose()
 gate.resolve(OPTIONS)
 await warming
 assert.equal(f.dash.tabData.size,0)
 assert.equal(f.dash.loadingTabs.size,0)
})

test('after sign-in, startup runs for the new session without requiring a tab click',async()=>{
 const f=fixture()
 f.backend.auth='none';await f.dash.preload()
 assert.equal(f.calls.length,0)
 f.backend.auth='token';f.session()
 await f.dash.preload()
 assert.equal(f.dash.tabData.size,5)
 assert.ok(f.calls.some(c=>c.route==='/api/progress/coaching'))
})
