import { Controller, Get, Param } from '@nestjs/common';
import { ValidationService } from './validation.service';

@Controller()
export class ValidationController {
  constructor(private readonly validationService: ValidationService) {}

  @Get('chapters/:chapterId/validation-issues')
  listByChapter(@Param('chapterId') chapterId: string) {
    return this.validationService.listByChapter(chapterId);
  }
}
