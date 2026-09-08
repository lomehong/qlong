/**
 * 日志关联规范(01 §11,评审 I-34):与任务相关的日志必须含
 * trace_id / task_id / attempt / msg_id 四字段(可外加 key_epoch)。
 * logTaskEvent 在调用点强制校验——缺字段直接抛错,让违规在开发期暴露而非排障期。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  trace_id?: string;
  task_id?: string;
  attempt?: number;
  msg_id?: string;
  key_epoch?: number;
  [k: string]: unknown;
}

export type QlongLogger = (level: LogLevel, msg: string, fields: LogFields) => void;

/** 任务相关日志的强制字段(01 §11) */
export const TASK_LOG_REQUIRED = ['trace_id', 'task_id', 'attempt', 'msg_id'] as const;

/** JSON 行日志器(结构化输出,采集端按行解析) */
export function makeJsonLogger(write: (line: string) => void = (l) => process.stderr.write(l + '\n')): QlongLogger {
  return (level, msg, fields) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  };
}

/**
 * 任务事件日志:强制四字段齐全(缺失 = TypeError)。
 * 非任务日志(如节点生命周期)请直接用底层 logger,不经此函数。
 */
export function logTaskEvent(
  logger: QlongLogger,
  level: LogLevel,
  msg: string,
  fields: LogFields & { trace_id: string; task_id: string; attempt: number; msg_id: string },
): void {
  for (const k of TASK_LOG_REQUIRED) {
    if (fields[k] === undefined || fields[k] === null) {
      throw new TypeError(`logTaskEvent: 缺少强制关联字段 ${k}(01 §11 日志关联规范)`);
    }
  }
  logger(level, msg, fields);
}
