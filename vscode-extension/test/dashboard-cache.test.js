const test = require('node:test')
const assert = require('node:assert/strict')
const {installVscode, OPTIONS} = require('./helpers')
const {vscode} = installVscode({})
vscode.extensions = {getExtension: () => ({packageJSON: {contributes: {commands: [], keybindings: []}}})}
const {Dashboard} = require('../dist/dashboard')
const {ApiError} = require('../dist/backend')
const delay = ms => new Promise(r => setTimeout(r, ms))
function deferred() {let resolve; const promise = new Promise(r => {resolve=r}); return {promise,resolve}}
function setup() {
  let session
  const calls=[],posted=[]
  const responses={'/api/llm-options':OPTIONS,'/api/evaluations':{models:[]},'/api/llm-configs':[],'/api/chats':[],'/api/context':{memory:[],content:'',saved_conversations:0},'/api/sessions?limit=20':[],'/api/progress/pending?limit=10':[]}
  const backend={url:'https://synthetic.example',auth:'token',managing:false,onDidChangeSession:fn=>{session=fn},status:()=>{throw new Error('Navigation must not call status')},api:async(route,method='GET')=>{calls.push([route,method]); await delay(5);const value=responses[route];return typeof value==='function'?value():value??{}}}
  const analyser={results:new Map(),onDidAnalyse:()=>{}}
  const chat={current:undefined,list:()=>backend.api('/api/chats'),setCurrent:async id=>{chat.current=id}}
  const dash=new Dashboard(backend,analyser,chat,{})
  dash.view={visible:true,webview:{postMessage:m=>posted.push(m)}}
  return {dash,backend,analyser,chat,calls,posted,responses,session:()=>session()}
}

test('fresh revisits reuse each tab snapshot for 15 seconds with no requests',async()=>{
  const f=setup()
  for(const tab of ['analyse','progress','profile','models','shortcuts']) await f.dash.handle({type:'tab',tab})
  const before=f.calls.length
  for(const tab of ['analyse','progress','profile','models','shortcuts']) await f.dash.handle({type:'tab',tab})
  assert.equal(f.calls.length,before)
  assert.equal(f.dash.tabData.size,5)
  assert.equal(f.posted.at(-1).tab,'shortcuts')
  assert.equal(f.posted.at(-1).refreshing,false)
})

test('a cache miss publishes loading synchronously; slow requests never leave the previous tab interactive',async()=>{
  const f=setup(),gate=deferred()
  f.responses['/api/context']=()=>gate.promise
  const action=f.dash.handle({type:'tab',tab:'profile'})
  assert.equal(f.posted[0].tab,'profile')
  assert.equal(f.posted[0].loading,true)
  gate.resolve({memory:[],content:'',saved_conversations:0})
  await action
  assert.equal(f.posted.at(-1).loading,undefined)
})

test('expired data is shown immediately while one background refresh replaces it',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'profile'})
  f.dash.tabData.get('profile').at=Date.now()-15001
  const gate=deferred()
  f.responses['/api/context']=()=>gate.promise
  f.posted.length=0
  const first=f.dash.reload(), second=f.dash.reload()
  assert.equal(first,second)
  assert.equal(f.posted[0].refreshing,true)
  assert.equal(f.posted[0].preferences,'')
  gate.resolve({memory:[],content:'New preferences',saved_conversations:0})
  await first
  assert.equal(f.posted.at(-1).preferences,'New preferences')
  assert.equal(f.posted.at(-1).refreshing,false)
})

test('a failed background refresh keeps cached content and shows an error without renewing its age',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'profile'})
  const at=Date.now()-15001;f.dash.tabData.get('profile').at=at
  f.responses['/api/context']=()=>{throw new Error('offline')}
  await f.dash.reload()
  assert.equal(f.posted.at(-1).preferences,'')
  assert.ok(f.posted.at(-1).refreshError)
  assert.equal(f.dash.tabData.get('profile').at,at)
})

test('a mutation invalidates other tabs and forces fresh data on the next visit',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'models'})
  await f.dash.handle({type:'tab',tab:'profile'})
  await f.dash.handle({type:'toggle',key:'use_enabled',on:true})
  assert.equal(f.dash.tabData.has('models'),false)
  const before=f.calls.length
  await f.dash.handle({type:'tab',tab:'models'})
  assert.ok(f.calls.length>before)
  assert.ok(f.calls.some(([path,method])=>path==='/api/context'&&method==='PUT'))
})

test('changing backend clears all snapshots, old model ids and analysis results',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'models'})
  f.analyser.results.set('previous-account',{})
  f.backend.url='https://other.example'
  await f.dash.handle({type:'tab',tab:'shortcuts'})
  assert.deepEqual([...f.dash.tabData.keys()],['shortcuts'])
  assert.deepEqual(f.dash.cache.configs,[])
  assert.equal(f.analyser.results.size,0)
  assert.ok(f.posted.some(p=>p.type==='resetTabs'))
})

test('a session event invalidates cached data even if URL and auth type are unchanged',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'models'})
  f.dash.tab='shortcuts'
  f.session()
  await f.dash.pendingReload?.promise
  assert.deepEqual([...f.dash.tabData.keys()],['shortcuts'])
  assert.ok(f.posted.some(p=>p.type==='resetTabs'))
})

test('401 during revalidation removes stale data immediately and prevents cached revisits',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'profile'})
  f.dash.tabData.get('profile').at=Date.now()-15001
  f.responses['/api/context']=()=>{throw new ApiError(401,'not_authenticated')}
  await f.dash.reload()
  assert.equal(f.dash.tabData.size,0)
  assert.equal(f.posted.at(-1).signedOut,true)
  const before=f.calls.length
  await f.dash.handle({type:'tab',tab:'models'})
  assert.equal(f.calls.length,before)
  assert.equal(f.posted.at(-1).signedOut,true)
})

test('Shortcuts loads with zero API calls even if the backend status would hang',async()=>{
  const f=setup()
  f.backend.status=()=>new Promise(()=>{})
  await f.dash.handle({type:'tab',tab:'shortcuts'})
  assert.deepEqual(f.calls,[])
  assert.deepEqual(f.posted.at(-1).shortcuts,[])
})

test('fresh status updates update only the account header, not the tab data',async()=>{
  const f=setup()
  await f.dash.handle({type:'tab',tab:'models'})
  const before=f.calls.length
  f.dash.updateStatus({url:f.backend.url,auth:'token',email:null,online:true,rejected:false})
  assert.equal(f.calls.length,before)
  assert.equal(f.posted.at(-1).type,'connection')
  f.dash.updateStatus({url:'https://old.example',auth:'token',email:null,online:true,rejected:false})
  assert.equal(f.posted.at(-1).type,'connection')
})

test('an Assistant snapshot for another selected conversation is never reused',async()=>{
  const f=setup()
  await f.dash.reload()
  f.chat.current='another'
  const before=f.calls.length
  await f.dash.reload()
  assert.ok(f.calls.length>before)
})

test('unlocked token-management pages bypass the tab cache',async()=>{
  const f=setup()
  f.backend.managing=true
  f.backend.tokenApi=async()=>[]
  await f.dash.handle({type:'tab',tab:'profile'})
  assert.equal(f.posted.at(-1).tokenMode,'open')
  assert.equal(f.dash.tabData.has('profile'),false)
  const before=f.calls.length
  await f.dash.reload()
  assert.ok(f.calls.length>before)
})

test('status results from an older refresh cannot overwrite a newer account header',async()=>{
  vscode.StatusBarAlignment={Right:2}
  vscode.MarkdownString=class {constructor(value){this.value=value}}
  vscode.window.createStatusBarItem=()=>({show(){},dispose(){}})
  const {StatusBar}=require('../dist/statusbar')
  const first=deferred(),second=deferred(),seen=[]
  let count=0
  const bar=new StatusBar({status:()=>++count===1?first.promise:second.promise},s=>seen.push(s))
  try{
    const old=bar.refresh(),fresh=bar.refresh()
    second.resolve({url:'https://example.test',online:true,email:'synthetic@example.test',auth:'token'})
    await fresh
    first.resolve({url:'https://old.example.test',online:true,email:'old@example.test',auth:'token'})
    await old
    assert.equal(seen.length,1)
    assert.equal(bar.last.url,'https://example.test')
  }finally{bar.dispose()}
})

test('relay checks follow session/model changes, not navigation, and its cached indicator stays live',async()=>{
  const f=setup()
  let checks=0
  f.dash.relay={refresh:async()=>{checks++},state:{state:'off',text:'Off'}}
  await f.dash.handle({type:'tab',tab:'models'})
  await f.dash.handle({type:'tab',tab:'profile'})
  f.dash.relay.state={state:'connected',text:'Connected'}
  await f.dash.handle({type:'tab',tab:'models'})
  assert.equal(checks,0)
  assert.equal(f.posted.at(-1).relay.state,'connected')
  await f.dash.act(async()=>{})
  assert.equal(checks,1)
  f.session()
  await f.dash.pendingReload?.promise
  assert.equal(checks,2)
})

test('populated My Progress preserves the backend saved.report envelope on load and cached revisit',async()=>{
  const f=setup()
  const fixture=require('./fixtures/progress-with-coaching.json')
  for(const key of ['activity','progress','dashboard','outcomes','learning','coaching']) f.responses[key==='progress'?'/api/progress':'/api/progress/'+key]=fixture[key]
  f.responses['/api/sessions?limit=20']=fixture.sessions.map(s=>({id:s.id,title:s.title,analysis_count:s.count,created_at:s.at}))
  await f.dash.handle({type:'tab',tab:'progress'})
  assert.deepEqual(f.posted.at(-1).coaching.saved.report,fixture.coaching.saved.report)
  assert.equal(f.posted.at(-1).sessions[0].count,2)
  const before=f.calls.length
  await f.dash.reload()
  assert.equal(f.calls.length,before)
  assert.equal(f.posted.at(-1).coaching.saved.report.suggestions[0].title,'Synthetic saved suggestion')
})
