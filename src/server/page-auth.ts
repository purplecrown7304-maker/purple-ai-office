import "server-only";
import { redirect } from "next/navigation";
import { createAuth } from "./auth";
import { getDatabase } from "./db";
import { OfficeService } from "./office-service";
export async function requireCeo() {
  let authorized = false;
  try {
    const owner = await (await createAuth(true)).userId();
    if (owner) {
      await new OfficeService(getDatabase()).authorize(owner);
      authorized = true;
    }
  } catch {}
  if (!authorized) redirect("/login");
}
