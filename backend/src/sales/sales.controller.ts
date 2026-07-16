import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { IngestAuth } from '../ingest/ingest-auth.decorator';
import { CreateSaleDto } from './dto/create-sale.dto';

/**
 * Sales ingest endpoint (spec S2.1 — foundation only).
 *
 * `POST /sales` is protected by `@IngestAuth()` (API key + rate limiting) and,
 * for now, is a stub that answers `501 Not Implemented`. The idempotent
 * persistence + catalog validation is S2.2, built on top of this already-merged
 * guard.
 */
@Controller('sales')
export class SalesController {
  @IngestAuth()
  @Post()
  create(@Body() dto: CreateSaleDto): never {
    // Placeholder until S2.2 wires the persistence flow. The DTO is validated by
    // the global ValidationPipe so the auth + payload contract is exercisable now.
    void dto;
    throw new HttpException(
      'POST /sales not implemented yet (S2.2)',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
