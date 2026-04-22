import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCharacterDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  roleType?: string;

  @IsOptional()
  @IsString()
  personalityCore?: string;

  @IsOptional()
  @IsString()
  motivation?: string;

  @IsOptional()
  @IsString()
  speechStyle?: string;

  @IsOptional()
  @IsString()
  backstory?: string;

  @IsOptional()
  @IsString()
  growthArc?: string;

  @IsOptional()
  @IsBoolean()
  isDead?: boolean;
}
