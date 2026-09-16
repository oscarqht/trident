export class NextResponse extends Response {
  static json(data: any, init?: ResponseInit): Response {
    return Response.json(data, init);
  }
  static redirect(url: string | URL, status: number = 302): Response {
    return Response.redirect(url, status);
  }
}

export type NextRequest = Request & {
  nextUrl: URL;
};
