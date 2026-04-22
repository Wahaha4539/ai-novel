import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateCharacterDto } from './dto/create-character.dto';
import { UpdateCharacterDto } from './dto/update-character.dto';
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

  @Get('projects/:projectId/characters/:characterId')
  getOne(@Param('projectId') projectId: string, @Param('characterId') characterId: string) {
    return this.charactersService.getOne(projectId, characterId);
  }

  @Patch('projects/:projectId/characters/:characterId')
  update(
    @Param('projectId') projectId: string,
    @Param('characterId') characterId: string,
    @Body() dto: UpdateCharacterDto,
  ) {
    return this.charactersService.update(projectId, characterId, dto);
  }

  @Delete('projects/:projectId/characters/:characterId')
  remove(@Param('projectId') projectId: string, @Param('characterId') characterId: string) {
    return this.charactersService.remove(projectId, characterId);
  }
}
