import { createAuth } from '../../../server/auth';
import { getDatabase } from '../../../server/db';
import { handleOfficeRequest } from '../../../server/http';
import { OfficeService } from '../../../server/office-service';
import { MockProvider } from '../../../providers/mock';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
async function handler(request:Request,context:{params:Promise<{path:string[]}>}) {
  try {
    const origin=process.env.APP_ORIGIN;
    if(!origin) throw new Error('SERVER_NOT_CONFIGURED');
    return await handleOfficeRequest(request,(await context.params).path,{auth:await createAuth(),office:new OfficeService(getDatabase(),new MockProvider(650)),origin});
  } catch {
    return Response.json({error:'SERVER_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'private, no-store'}});
  }
}
export { handler as GET, handler as POST };
