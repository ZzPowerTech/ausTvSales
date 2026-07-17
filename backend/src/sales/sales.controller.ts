import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IngestAuth } from '../ingest/ingest-auth.decorator';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SalesService } from './sales.service';

/** Body returned to the plugin — the status code is the primary signal (§2.3). */
interface SaleAck {
  sale_id: string;
  status: 'recorded' | 'duplicate';
}

/**
 * Sales ingest endpoint (spec S2.2).
 *
 * `POST /sales` is protected by `@IngestAuth()` (API key + rate limiting) and
 * persists the sale idempotently after validating the catalog. Status codes are
 * a hard contract with the Sprint 3 queue worker (see backend/README.md §2.3):
 *  - `201 Created` on a newly stored sale, `200 OK` on an idempotent replay — both
 *    are a definitive ACK, so the plugin must not re-enqueue either.
 *  - `422` (unknown/inactive item) and `400` (malformed payload) are permanent.
 *  - `5xx`/timeout stays transient (the worker re-enqueues).
 */
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @IngestAuth()
  @Post()
  async create(
    @Body() dto: CreateSaleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleAck> {
    const { created } = await this.salesService.record(dto);
    // 201 distinguishes a fresh write from a replay for observability; both are
    // 2xx, so the plugin treats them identically (ACK, do not re-enqueue).
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { sale_id: dto.sale_id, status: created ? 'recorded' : 'duplicate' };
  }
}
