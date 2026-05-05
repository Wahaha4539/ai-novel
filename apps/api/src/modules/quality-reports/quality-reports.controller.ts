import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateQualityReportDto } from './dto/create-quality-report.dto';
import { ListQualityReportsQueryDto } from './dto/list-quality-reports-query.dto';
import { UpdateQualityReportDto } from './dto/update-quality-report.dto';
import { QualityReportsService } from './quality-reports.service';

@Controller()
export class QualityReportsController {
  constructor(private readonly qualityReportsService: QualityReportsService) {}

  @Get('projects/:projectId/quality-reports')
  list(@Param('projectId') projectId: string, @Query() query: ListQualityReportsQueryDto) {
    return this.qualityReportsService.list(projectId, query);
  }

  @Post('projects/:projectId/quality-reports')
  create(@Param('projectId') projectId: string, @Body() dto: CreateQualityReportDto) {
    return this.qualityReportsService.create(projectId, dto);
  }

  @Patch('projects/:projectId/quality-reports/:reportId')
  update(
    @Param('projectId') projectId: string,
    @Param('reportId') reportId: string,
    @Body() dto: UpdateQualityReportDto,
  ) {
    return this.qualityReportsService.update(projectId, reportId, dto);
  }

  @Delete('projects/:projectId/quality-reports/:reportId')
  remove(@Param('projectId') projectId: string, @Param('reportId') reportId: string) {
    return this.qualityReportsService.remove(projectId, reportId);
  }
}
