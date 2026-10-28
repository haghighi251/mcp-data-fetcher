import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const port = Number(process.env["BFF_PORT"] ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[bff] data-core BFF listening on :${port}`);
}

void bootstrap();
