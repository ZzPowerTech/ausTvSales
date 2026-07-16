import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ItemsService } from './items.service';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import type { Item } from '../db/schema';

/**
 * Catalog item administration (spec S1.6). Protected by the global
 * {@link AdminTokenGuard}, reads included (see CategoriesController note).
 */
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @Post()
  create(@Body() dto: CreateItemDto): Promise<Item> {
    return this.itemsService.create(dto);
  }

  @Get()
  findAll(): Promise<Item[]> {
    return this.itemsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Item> {
    return this.itemsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateItemDto,
  ): Promise<Item> {
    return this.itemsService.update(id, dto);
  }
}
