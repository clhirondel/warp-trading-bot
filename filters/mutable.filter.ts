import { Filter, FilterResult, MinimalTokenMetadata } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk'; // Note: This might be deprecated or moved in newer SDKs
import { MetadataAccountData, MetadataAccountDataArgs, MPL_TOKEN_METADATA_PROGRAM_ID } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';
import axios from 'axios'; // Import axios for fetching URI data

export class MutableFilter implements Filter {
  readonly requiresMetadata = true; // This filter needs metadata
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {
    if (this.checkMutable) {
      this.errorMessage.push('mutable');
    }

    if (this.checkSocials) {
      this.errorMessage.push('socials');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4, metadata?: MinimalTokenMetadata): Promise<FilterResult> {
    // Use the passed-in metadata if available
    if (!metadata) {
      return { ok: false, message: 'MutableSocials -> Metadata not available' };
    }

    try {
      // Check mutability directly from the passed metadata
      const isMutable = this.checkMutable && (metadata.isMutable === undefined || metadata.isMutable === true); // Treat undefined as mutable for safety

      // Check socials using the URI from the passed metadata
      const hasSocials = !this.checkSocials || (metadata.uri ? await this.hasSocials(metadata.uri) : false);

      const ok = !isMutable && hasSocials;
      const message: string[] = [];

      if (isMutable) {
        message.push('metadata is mutable');
      }

      if (!hasSocials && this.checkSocials) { // Only add message if checkSocials is enabled
        message.push('has no socials');
      }

      if (!ok) {
        const finalMessage = `MutableSocials -> Token ${message.join(' and ')}`;
        logger.trace({ mint: poolKeys.baseMint.toString() }, finalMessage);
        return { ok: false, message: finalMessage };
      }

      return { ok: true };

    } catch (e: any) {
      logger.error({ mint: poolKeys.baseMint.toString(), error: e }, `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`);
      return {
        ok: false,
        message: `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')} due to error: ${e.message}`,
      };
    }
  }

  private async hasSocials(uri: string): Promise<boolean> {
    if (!uri) {
      logger.trace('Socials check: URI is empty.');
      return false;
    }

    try {
      // Basic check for common protocols - might need refinement
      if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
        logger.trace({ uri }, 'Socials check: URI is not HTTP/HTTPS, skipping fetch.');
        // Consider if non-HTTP URIs should pass or fail based on requirements
        return false; // Assuming non-HTTP URIs don't contain standard socials
      }

      // Add timeout and error handling for the fetch request
      const response = await axios.get(uri, { timeout: 5000 }); // 5 second timeout
      const data = response.data;

      // Check if data is an object and has an 'extensions' property
      if (typeof data !== 'object' || data === null || typeof data.extensions !== 'object' || data.extensions === null) {
        logger.trace({ uri }, 'Socials check: Metadata JSON has no "extensions" object.');
        return false;
      }

      // Check if any value within the extensions object is a non-empty string or array
      const extensions = data.extensions;
      for (const key in extensions) {
        if (Object.prototype.hasOwnProperty.call(extensions, key)) {
          const value = extensions[key];
          if (typeof value === 'string' && value.trim().length > 0) {
            logger.trace({ uri, key, value }, `Socials check: Found social link for ${key}.`);
            return true; // Found a non-empty string value
          }
          // Optionally check for non-empty arrays if that's a possible format
          // if (Array.isArray(value) && value.length > 0) {
          //   return true;
          // }
        }
      }

      logger.trace({ uri }, 'Socials check: No non-empty social links found in extensions.');
      return false; // No non-empty values found
    } catch (error: any) {
      // Handle specific axios errors or general errors
      if (axios.isAxiosError(error)) {
        logger.warn({ uri, status: error.response?.status, error: error.message }, `Socials check: Failed to fetch or parse metadata URI (Axios Error).`);
      } else {
        logger.warn({ uri, error: error.message }, `Socials check: Failed to fetch or parse metadata URI.`);
      }
      return false; // Treat fetch/parse errors as "no socials found"
    }
  }
}