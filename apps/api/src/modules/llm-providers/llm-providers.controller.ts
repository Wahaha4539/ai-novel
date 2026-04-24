import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Put,
  Param,
  Body,
} from '@nestjs/common';
import { LlmProvidersService } from './llm-providers.service';
import { CreateLlmProviderDto } from './dto/create-llm-provider.dto';
import { UpdateLlmProviderDto } from './dto/update-llm-provider.dto';
import { SetRoutingDto } from './dto/set-routing.dto';

/**
 * REST controller for LLM Provider management and step routing.
 *
 * Provider endpoints: /api/llm-providers
 * Routing endpoints:  /api/llm-routing
 */
@Controller()
export class LlmProvidersController {
  constructor(private readonly service: LlmProvidersService) {}

  // ── Provider CRUD ─────────────────────────────────────

  /** List all providers (apiKey masked) */
  @Get('llm-providers')
  listProviders() {
    return this.service.listProviders();
  }

  /** Get single provider by ID */
  @Get('llm-providers/:id')
  getProvider(@Param('id') id: string) {
    return this.service.getProvider(id);
  }

  /** Create a new provider */
  @Post('llm-providers')
  createProvider(@Body() dto: CreateLlmProviderDto) {
    return this.service.createProvider(dto);
  }

  /** Update a provider */
  @Patch('llm-providers/:id')
  updateProvider(@Param('id') id: string, @Body() dto: UpdateLlmProviderDto) {
    return this.service.updateProvider(id, dto);
  }

  /** Delete a provider (cascades routing) */
  @Delete('llm-providers/:id')
  deleteProvider(@Param('id') id: string) {
    return this.service.deleteProvider(id);
  }

  /** Test provider connectivity */
  @Post('llm-providers/:id/test')
  testConnectivity(@Param('id') id: string) {
    return this.service.testConnectivity(id);
  }

  // ── Routing ───────────────────────────────────────────

  /** Get all step routings (guided / generate / polish) */
  @Get('llm-routing')
  listRoutings() {
    return this.service.listRoutings();
  }

  /** Set or update routing for a step */
  @Put('llm-routing/:appStep')
  setRouting(@Param('appStep') appStep: string, @Body() dto: SetRoutingDto) {
    return this.service.setRouting(appStep, dto);
  }

  /** Remove routing for a step */
  @Delete('llm-routing/:appStep')
  deleteRouting(@Param('appStep') appStep: string) {
    return this.service.deleteRouting(appStep);
  }
}
