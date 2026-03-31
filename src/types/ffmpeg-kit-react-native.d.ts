declare module 'ffmpeg-kit-react-native' {
  interface Session {
    getReturnCode(): Promise<ReturnCode>;
    getOutput(): Promise<string>;
    getLogsAsString(): Promise<string>;
  }

  interface ReturnCode {
    getValue(): number;
  }

  export const ReturnCode: {
    isSuccess(code: ReturnCode): boolean;
  };

  export const FFmpegKit: {
    execute(command: string): Promise<Session>;
  };

  export const FFprobeKit: {
    execute(command: string): Promise<Session>;
  };
}
