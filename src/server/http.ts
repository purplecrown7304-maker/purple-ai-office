import 'server-only';
import { z } from 'zod';
import type { OfficeAuth } from './auth';
import type { OfficeService } from './office-service';
import { requireThat, ServiceError, uuid } from './validation';

const credentials=z.strictObject({email:z.email().max(254),password:z.string().min(1).max(1024)});
const empty=z.strictObject({});
async function readBody(request:Request):Promise<unknown> {
  requireThat(request.headers.get('content-type')?.split(';')[0]==='application/json','JSON_REQUIRED',415);
  // Limit bytes while streaming, not just Content-Length (which is untrusted).
  const reader=request.body?.getReader();
  if(!reader) return {};
  const decoder=new TextDecoder(); let body='',size=0;
  try { while(true) { const {done,value}=await reader.read(); if(done) break;
    size+=value.byteLength; if(size>65536) { await reader.cancel(); throw new ServiceError('BODY_TOO_LARGE',413); }
    body+=decoder.decode(value,{stream:true});
  } } finally { reader.releaseLock(); }
  try { return JSON.parse(body+decoder.decode()); } catch { throw new ServiceError('INVALID_JSON',400); }
}
export async function handleOfficeRequest(request:Request,path:string[],deps:{auth:OfficeAuth;office:OfficeService;origin:string}):Promise<Response> {
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
  try {
    const write=request.method==='POST';
    requireThat(write||request.method==='GET','METHOD_NOT_ALLOWED',405);
    if(write) requireThat(request.headers.get('origin')===new URL(deps.origin).origin,'ORIGIN_DENIED',403);
    const body=write?await readBody(request):undefined;
    if(write&&path.join('/')==='login') {
      const input=credentials.parse(body),id=await deps.auth.login(input.email,input.password);
      try { await deps.office.authorize(id); } catch { await deps.auth.logout(); throw new ServiceError('CEO_REQUIRED',403); }
      return reply({userId:id});
    }
    const owner=await deps.auth.userId(); requireThat(owner,'AUTH_REQUIRED',401);
    await deps.office.authorize(owner);
    if(write&&path.join('/')==='logout') { empty.parse(body); await deps.auth.logout(); return reply({ok:true}); }
    if(!write&&path.join('/')==='session') return reply({userId:owner});
    const resource=path[0];
    if(!write&&path.length===1&&(resource==='projects'||resource==='agents'||resource==='tasks')) return reply(await deps.office.list(owner,resource));
    if(!write&&resource==='tasks'&&path.length===2) return reply(await deps.office.detail(owner,path[1]));
    if(!write&&resource==='projects'&&path.length===2) return reply(await deps.office.projectDetail(owner,path[1]));
    if(!write&&resource==='agents'&&path.length===2) return reply(await deps.office.agentDetail(owner,path[1]));
    if(write) {
      const key=uuid.parse(request.headers.get('idempotency-key'));
      if(path.length===1&&resource==='projects') return reply(await deps.office.createProject(owner,key,body),201);
      if(path.length===1&&resource==='agents') return reply(await deps.office.createAgent(owner,key,body),201);
      if(path.length===1&&resource==='tasks') return reply(await deps.office.createTask(owner,key,body),201);
      if(resource==='tasks'&&path.length===3) {
        if(path[2]==='step') { empty.parse(body); return reply(await deps.office.step(owner,path[1],key)); }
        if(path[2]==='decision') return reply(await deps.office.decide(owner,path[1],key,body));
      }
    }
    throw new ServiceError('NOT_FOUND',404);
  } catch(error) {
    if(error instanceof ServiceError) return reply({error:error.code},error.status);
    if(error instanceof z.ZodError) return reply({error:'INVALID_INPUT'},400);
    // Domain errors are stable codes. Never expose SQL, credential values, raw
    // provider errors, constraint details or server stack traces in API responses.
    if(error instanceof Error&&/^[A-Z][A-Z_]+$/.test(error.message)) return reply({error:error.message},409);
    return reply({error:'REQUEST_FAILED'},500);
  }
}
