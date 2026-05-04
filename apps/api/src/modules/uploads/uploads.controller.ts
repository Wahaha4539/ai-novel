import { BadRequestException, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES, UploadedCreativeDocumentFile, UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('creative-document')
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES,
      files: 1,
    },
  }))
  uploadCreativeDocument(@UploadedFile() file?: UploadedCreativeDocumentFile) {
    if (!file) throw new BadRequestException('缺少上传文件字段 file。');
    return this.uploadsService.uploadCreativeDocument(file);
  }
}
