export interface Data {
  type: string
  body: Request | Response | Log | StatusUpdate
}

export interface Request {
  id: number
  type: string
  settings: Record<string, any>
}

export interface Response {
  id: number
  success: boolean
  errorMsg?: string
}

export interface Log {
  level: string
  msg: string
}

export interface StatusUpdate {
  type: string
  status: Record<string, any>
}
