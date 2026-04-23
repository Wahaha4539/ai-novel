import { IsArray, IsString } from 'class-validator';

export class ReorderVolumesDto {
  @IsArray()
  @IsString({ each: true })
  volumeIds!: string[];
}
