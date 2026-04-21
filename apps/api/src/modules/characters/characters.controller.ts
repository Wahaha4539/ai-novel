import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateCharacterDto } from './dto/create-character.dto';
import { CharactersService } from './characters.service';

@Controller()
export class CharactersController {
  constructor(private readonly charactersService: CharactersService) {}

  @Post('projects/:projectId/characters')
  create(@Param('projectId') projectId: string, @Body() dto: CreateCharacterDto) {
    return this.charactersService.create(projectId, dto);
  }

  @Get('projects/:projectId/characters')
  list(@Param('projectId') projectId: string) {
    return this.charactersService.listByProject(projectId);
  }
}
