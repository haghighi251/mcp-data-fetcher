import { Module } from "@nestjs/common";
import { DataModule } from "./data/data.module.js";

@Module({
  imports: [DataModule],
})
export class AppModule {}
