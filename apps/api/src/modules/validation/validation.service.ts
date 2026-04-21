import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ValidationService {
  constructor(private readonly prisma: PrismaService) {}

  listByChapter(chapterId: string) {
    return this.prisma.validationIssue.findMany({
      where: { chapterId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
