/** 平台 HTTP 处理器：Web 标准 Request → Response，便于注入测试 */
export type HttpHandler = (request: Request, env: Record<string, string>) => Promise<Response>
