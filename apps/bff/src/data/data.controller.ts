import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { DataService } from "./data.service.js";

/**
 * HTTP surface of the BFF. The gateway forwards Global Query payloads here.
 * Structured results are returned as-is (HTTP 200 for ok, 422 for a handled
 * error) so upstream callers branch on `result.ok`, never on thrown exceptions.
 */
@Controller("data")
export class DataController {
  constructor(private readonly data: DataService) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Post("query")
  @HttpCode(200)
  async query(@Body() payload: unknown): Promise<unknown> {
    return this.data.run(payload);
  }

  @Post("invalidate")
  @HttpCode(200)
  async invalidate(@Body() payload: unknown): Promise<unknown> {
    return this.data.invalidate(payload);
  }
}
