import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
  AnalyticsService,
  type CategoryItemsReport,
  type SeriesReport,
  type TopBuyersReport,
} from './analytics.service';
import { PeriodQueryDto } from './dto/period-query.dto';
import { SeriesQueryDto } from './dto/series-query.dto';
import { TopBuyersQueryDto } from './dto/top-buyers-query.dto';

/**
 * Dashboard analytics reads (spec S5.1).
 *
 * Every route is protected by the global `SessionAuthGuard` — nothing here is
 * `@Public()`, so a missing session is a 401 by default (the deny-by-default
 * design that CategoriesController relies on too). The three shapes back the
 * category page (S5.3) and the time-series chart (S5.4).
 *
 * `:id` is the integer category id (`ParseIntPipe`); `:itemId` is the opaque
 * business key (`caixaNatal2026`) and stays text — no numeric pipe.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('categories/:id/items')
  categoryItems(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PeriodQueryDto,
  ): Promise<CategoryItemsReport> {
    return this.analytics.categoryItems(id, query);
  }

  @Get('items/:itemId/top-buyers')
  topBuyers(
    @Param('itemId') itemId: string,
    @Query() query: TopBuyersQueryDto,
  ): Promise<TopBuyersReport> {
    return this.analytics.topBuyers(itemId, query, query.limit);
  }

  @Get('items/:itemId/series')
  series(
    @Param('itemId') itemId: string,
    @Query() query: SeriesQueryDto,
  ): Promise<SeriesReport> {
    return this.analytics.series(itemId, query, query.bucket);
  }
}
