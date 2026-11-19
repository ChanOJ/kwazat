import { getAuth } from "@/lib/auth.ts";

async function handle(request: Request): Promise<Response> {
  return (await getAuth()).handler(request);
}

export { handle as GET, handle as POST };
