export async function GET(): Promise<Response> {
  return new Response('[1]');
}

export async function POST(request: Request): Promise<Response> {
  return new Response(await request.text());
}
