import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { ServiceError } from './validation';

export interface OfficeAuth {
  userId(): Promise<string|null>;
  login(email:string,password:string):Promise<string>;
  logout():Promise<void>;
}
export async function createAuth(readOnly=false):Promise<OfficeAuth> {
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key) throw new ServiceError('SERVER_NOT_CONFIGURED',503);
  const jar=await cookies();
  const client=createServerClient(url,key,{cookies:{getAll:()=>jar.getAll(),setAll:values=>{
    if(readOnly) return; // Page checks are read-only; API requests persist refresh cookies.
    for(const {name,value,options} of values) jar.set(name,value,{...options,sameSite:'lax',secure:process.env.NODE_ENV==='production'});
  }}});
  return {
    async userId() { const {data,error}=await client.auth.getUser(); return error?null:data.user?.id??null; },
    async login(email,password) {
      const {data,error}=await client.auth.signInWithPassword({email,password});
      if(error||!data.user) throw new ServiceError('INVALID_CREDENTIALS',401);
      return data.user.id;
    },
    async logout() { const {error}=await client.auth.signOut(); if(error) throw new ServiceError('SIGN_OUT_FAILED',503); },
  };
}
