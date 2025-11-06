import fs from 'fs/promises';
import path from 'path';
import { getCache, setCache, deleteCache } from '../config/redisClient';
import ImageCache, { IImageCache } from '../models/ImageCache';

const IMAGE_CACHE_DIR = path.join(process.cwd(), 'public', 'cached-photos');
const CACHE_DURATION_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

// Ensure cache directory exists
async function ensureCacheDir(): Promise<void> {
  try {
    await fs.access(IMAGE_CACHE_DIR);
  } catch {
    await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
  }
}

// Generate filename from photo reference
function getPhotoFilename(photoRef: string, maxWidth: number): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(photoRef).digest('hex');
  return `photo_${hash}_${maxWidth}.jpg`;
}

// Generate hash for photo reference
function generatePhotoHash(photoRef: string, maxWidth: number): string {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(`${photoRef}_${maxWidth}`).digest('hex');
}

// Check MongoDB for cached image record
async function getMongoCachedImage(photoRef: string, maxWidth: number): Promise<IImageCache | null> {
  try {
    const hash = generatePhotoHash(photoRef, maxWidth);
    const cachedImage = await ImageCache.findOne({ 
      $or: [
        { photoReference: photoRef, width: maxWidth },
        { hash: hash }
      ]
    });

    if (cachedImage) {
      // Check if file still exists
      try {
        await fs.access(cachedImage.filePath);
        
        // Update access stats
        await ImageCache.updateOne(
          { _id: cachedImage._id },
          { 
            $inc: { accessCount: 1 },
            $set: { lastAccessed: new Date() }
          }
        );
        
        return cachedImage;
      } catch {
        // File doesn't exist, remove from MongoDB
        await ImageCache.deleteOne({ _id: cachedImage._id });
        return null;
      }
    }
    return null;
  } catch (error) {
    console.error('MongoDB image cache lookup error:', error);
    return null;
  }
}

// Save image record to MongoDB
async function saveImageToMongo(
  photoRef: string, 
  filename: string, 
  filePath: string, 
  url: string, 
  maxWidth: number,
  fileSize: number,
  facilityId?: string,
  googlePlaceId?: string
): Promise<void> {
  try {
    const hash = generatePhotoHash(photoRef, maxWidth);
    
    const imageCache = new ImageCache({
      photoReference: photoRef,
      filename,
      filePath,
      url,
      width: maxWidth,
      fileSize,
      mimeType: 'image/jpeg',
      facilityId,
      googlePlaceId,
      downloadedAt: new Date(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
      accessCount: 1,
      lastAccessed: new Date(),
      hash,
    });

    await imageCache.save();
    console.log(`💾 Image metadata saved to MongoDB: ${filename}`);
  } catch (error: any) {
    if (error.code === 11000) {
      // Duplicate key error, image already exists
      console.log(`ℹ️ Image already exists in MongoDB: ${filename}`);
    } else {
      console.error('Failed to save image metadata to MongoDB:', error);
    }
  }
}

// Check if cached photo exists and is fresh
async function getCachedPhotoPath(photoRef: string, maxWidth: number): Promise<string | null> {
  await ensureCacheDir();
  const filename = getPhotoFilename(photoRef, maxWidth);
  const filepath = path.join(IMAGE_CACHE_DIR, filename);
  
  try {
    const stats = await fs.stat(filepath);
    const isFresh = Date.now() - stats.mtimeMs < CACHE_DURATION_MS;
    
    if (isFresh) {
      return `/cached-photos/${filename}`;
    } else {
      // Delete stale cache
      await fs.unlink(filepath);
      // Also remove from MongoDB
      await ImageCache.deleteOne({ 
        $or: [
          { photoReference: photoRef, width: maxWidth },
          { hash: generatePhotoHash(photoRef, maxWidth) }
        ]
      });
    }
  } catch {
    // File doesn't exist or error reading
  }
  
  return null;
}

// Download and cache photo with MongoDB storage
async function downloadAndCachePhoto(
  photoRef: string, 
  maxWidth: number, 
  facilityId?: string,
  googlePlaceId?: string
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY is required for photo download');
    return null;
  }

  try {
    const googleUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photoreference=${photoRef}&key=${apiKey}`;
    
    console.log(`📸 Downloading photo: ${photoRef.substring(0, 20)}...`);
    
    const response = await fetch(googleUrl);
    if (!response.ok) {
      throw new Error(`Google API responded with status: ${response.status}`);
    }
    
    const imageBuffer = await response.arrayBuffer();
    await ensureCacheDir();
    const filename = getPhotoFilename(photoRef, maxWidth);
    const filepath = path.join(IMAGE_CACHE_DIR, filename);
    
    await fs.writeFile(filepath, Buffer.from(imageBuffer));
    
    const fileStats = await fs.stat(filepath);
    const url = `/cached-photos/${filename}`;
    
    // Save to MongoDB
    await saveImageToMongo(
      photoRef, 
      filename, 
      filepath, 
      url, 
      maxWidth, 
      fileStats.size,
      facilityId,
      googlePlaceId
    );
    
    console.log(`✅ Photo cached: ${filename} (${fileStats.size} bytes)`);
    return url;
  } catch (error) {
    console.error('❌ Failed to download and cache photo:', error);
    return null;
  }
}

// Main function to get photo URL with 3-layer caching
export async function getCachedPhotoUrl(
  photoRef: string, 
  maxWidth: number = 600,
  facilityId?: string,
  googlePlaceId?: string
): Promise<string | null> {
  if (!photoRef) return null;

  // 1️⃣ Check Redis cache first for the URL
  const redisKey = `photo_url:${photoRef}:${maxWidth}`;
  const cachedUrl = await getCache(redisKey);
  if (cachedUrl) {
    console.log('⚡ Photo URL served from Redis cache');
    
    // Update MongoDB access stats
    await ImageCache.updateOne(
      { 
        $or: [
          { photoReference: photoRef, width: maxWidth },
          { hash: generatePhotoHash(photoRef, maxWidth) }
        ]
      },
      { 
        $inc: { accessCount: 1 },
        $set: { lastAccessed: new Date() }
      }
    ).catch(console.error);
    
    return cachedUrl;
  }

  // 2️⃣ Check MongoDB cache
  const mongoCache = await getMongoCachedImage(photoRef, maxWidth);
  if (mongoCache) {
    console.log('🗄️ Photo served from MongoDB cache');
    // Cache in Redis for faster access
    await setCache(redisKey, mongoCache.url, CACHE_DURATION_MS / 1000);
    return mongoCache.url;
  }

  // 3️⃣ Check local file system cache
  const cachedPath = await getCachedPhotoPath(photoRef, maxWidth);
  if (cachedPath) {
    console.log('💾 Photo served from local file cache');
    
    // Save to MongoDB and Redis
    const filename = getPhotoFilename(photoRef, maxWidth);
    const filepath = path.join(IMAGE_CACHE_DIR, filename);
    
    try {
      const fileStats = await fs.stat(filepath);
      await saveImageToMongo(
        photoRef, 
        filename, 
        filepath, 
        cachedPath, 
        maxWidth, 
        fileStats.size,
        facilityId,
        googlePlaceId
      );
    } catch (error) {
      console.error('Error saving to MongoDB after file cache hit:', error);
    }
    
    await setCache(redisKey, cachedPath, CACHE_DURATION_MS / 1000);
    
    return cachedPath;
  }

  // 4️⃣ Download and cache the photo
  const newPath = await downloadAndCachePhoto(photoRef, maxWidth, facilityId, googlePlaceId);
  if (newPath) {
    // Cache in Redis
    await setCache(redisKey, newPath, CACHE_DURATION_MS / 1000);
  }
  
  return newPath;
}

// Batch download photos for multiple facilities with MongoDB storage
export async function batchCacheFacilityPhotos(
  facilities: Array<{ 
    id: string; 
    photoRefs: string[];
    googlePlaceId?: string;
  }>,
  maxWidth: number = 600
): Promise<Map<string, string[]>> {
  const results = new Map<string, string[]>();
  
  console.log(`🔄 Batch caching photos for ${facilities.length} facilities`);
  
  for (const facility of facilities) {
    const cachedUrls: string[] = [];
    
    // Only process first 4 photos per facility
    const photoRefsToProcess = facility.photoRefs.slice(0, 4);
    
    for (const photoRef of photoRefsToProcess) {
      const cachedUrl = await getCachedPhotoUrl(
        photoRef, 
        maxWidth, 
        facility.id, 
        facility.googlePlaceId
      );
      if (cachedUrl) {
        cachedUrls.push(cachedUrl);
      }
    }
    
    results.set(facility.id, cachedUrls);
    console.log(`✅ Cached ${cachedUrls.length} photos for facility ${facility.id}`);
  }
  
  return results;
}

// Get all cached photo URLs for a facility
export async function getFacilityCachedPhotos(
  facilityId: string, 
  photoRefs: string[]
): Promise<string[]> {
  const cachedUrls: string[] = [];
  
  for (const photoRef of photoRefs.slice(0, 4)) {
    const cachedUrl = await getCachedPhotoUrl(photoRef, 600, facilityId);
    if (cachedUrl) {
      cachedUrls.push(cachedUrl);
    }
  }
  
  return cachedUrls;
}

// Get image cache statistics
export async function getImageCacheStats(): Promise<{
  totalImages: number;
  totalSize: number;
  totalAccessCount: number;
  mostAccessed: any[]; // Use any[] instead of IImageCache[]
  recentDownloads: any[]; // Use any[] instead of IImageCache[]
  storageByFacility: Array<{ facilityId: string; count: number; totalSize: number }>;
}> {
  try {
    const totalImages = await ImageCache.countDocuments();
    
    const sizeStats = await ImageCache.aggregate([
      {
        $group: {
          _id: null,
          totalSize: { $sum: "$fileSize" },
          totalAccessCount: { $sum: "$accessCount" }
        }
      }
    ]);
    
    // Remove .lean() and convert to plain objects
    const mostAccessed = await ImageCache.find()
      .sort({ accessCount: -1 })
      .limit(10)
      .lean()
      .then(docs => docs.map(doc => doc.toObject ? doc.toObject() : doc));

    const recentDownloads = await ImageCache.find()
      .sort({ downloadedAt: -1 })
      .limit(10)
      .lean()
      .then(docs => docs.map(doc => doc.toObject ? doc.toObject() : doc));
    
    const storageByFacility = await ImageCache.aggregate([
      {
        $match: { facilityId: { $exists: true, $ne: null } }
      },
      {
        $group: {
          _id: "$facilityId",
          count: { $sum: 1 },
          totalSize: { $sum: "$fileSize" }
        }
      },
      {
        $sort: { totalSize: -1 }
      },
      {
        $limit: 10
      }
    ]);

    return {
      totalImages,
      totalSize: sizeStats[0]?.totalSize || 0,
      totalAccessCount: sizeStats[0]?.totalAccessCount || 0,
      mostAccessed,
      recentDownloads,
      storageByFacility: storageByFacility.map(item => ({
        facilityId: item._id,
        count: item.count,
        totalSize: item.totalSize
      }))
    };
  } catch (error) {
    console.error('Error getting image cache stats:', error);
    return {
      totalImages: 0,
      totalSize: 0,
      totalAccessCount: 0,
      mostAccessed: [],
      recentDownloads: [],
      storageByFacility: []
    };
  }
}

// Clean up expired images from all storage layers
export async function cleanupExpiredImages(): Promise<{ 
  deletedFiles: number; 
  deletedRecords: number;
  deletedRedisKeys: number;
}> {
  let deletedFiles = 0;
  let deletedRecords = 0;
  let deletedRedisKeys = 0;
  
  try {
    // Find expired records in MongoDB
    const expiredRecords = await ImageCache.find({
      expiresAt: { $lt: new Date() }
    });
    
    for (const record of expiredRecords) {
      try {
        // Delete file from file system
        await fs.unlink(record.filePath);
        deletedFiles++;
      } catch (error) {
        // File might already be deleted
      }
      
      // Delete from Redis
      const redisKey = `photo_url:${record.photoReference}:${record.width}`;
      await deleteCache(redisKey);
      deletedRedisKeys++;
      
      // Delete from MongoDB
      await ImageCache.deleteOne({ _id: record._id });
      deletedRecords++;
    }
    
    console.log(`🧹 Cleanup completed: ${deletedFiles} files, ${deletedRecords} MongoDB records, ${deletedRedisKeys} Redis keys removed`);
  } catch (error) {
    console.error('Error during image cache cleanup:', error);
  }
  
  return { deletedFiles, deletedRecords, deletedRedisKeys };
}


// Get images by facility ID
export async function getFacilityImages(facilityId: string): Promise<any[]> { // Use any[] instead of IImageCache[]
  try {
    const images = await ImageCache.find({ facilityId })
      .sort({ downloadedAt: -1 })
      .lean();
    
    return images.map(doc => doc.toObject ? doc.toObject() : doc);
  } catch (error) {
    console.error('Error getting facility images:', error);
    return [];
  }
}

// Delete images for a specific facility
export async function deleteFacilityImages(facilityId: string): Promise<{ 
  deletedFiles: number; 
  deletedRecords: number;
  deletedRedisKeys: number;
}> {
  let deletedFiles = 0;
  let deletedRecords = 0;
  let deletedRedisKeys = 0;
  
  try {
    const facilityImages = await ImageCache.find({ facilityId });
    
    for (const image of facilityImages) {
      try {
        // Delete file from file system
        await fs.unlink(image.filePath);
        deletedFiles++;
      } catch (error) {
        // File might already be deleted
      }
      
      // Delete from Redis
      const redisKey = `photo_url:${image.photoReference}:${image.width}`;
      await deleteCache(redisKey);
      deletedRedisKeys++;
      
      // Delete from MongoDB
      await ImageCache.deleteOne({ _id: image._id });
      deletedRecords++;
    }
    
    console.log(`🗑️ Deleted ${deletedFiles} files, ${deletedRecords} records, ${deletedRedisKeys} Redis keys for facility ${facilityId}`);
  } catch (error) {
    console.error('Error deleting facility images:', error);
  }
  
  return { deletedFiles, deletedRecords, deletedRedisKeys };
}

// Search images by various criteria
export async function searchImages(criteria: {
  facilityId?: string;
  googlePlaceId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  minSize?: number;
  maxSize?: number;
}): Promise<any[]> { // Use any[] instead of IImageCache[]
  try {
    const query: any = {};
    
    if (criteria.facilityId) {
      query.facilityId = criteria.facilityId;
    }
    
    if (criteria.googlePlaceId) {
      query.googlePlaceId = criteria.googlePlaceId;
    }
    
    if (criteria.dateFrom || criteria.dateTo) {
      query.downloadedAt = {};
      if (criteria.dateFrom) query.downloadedAt.$gte = criteria.dateFrom;
      if (criteria.dateTo) query.downloadedAt.$lte = criteria.dateTo;
    }
    
    if (criteria.minSize || criteria.maxSize) {
      query.fileSize = {};
      if (criteria.minSize) query.fileSize.$gte = criteria.minSize;
      if (criteria.maxSize) query.fileSize.$lte = criteria.maxSize;
    }
    
    const images = await ImageCache.find(query)
      .sort({ downloadedAt: -1 })
      .lean();
    
    return images.map(doc => doc.toObject ? doc.toObject() : doc);
  } catch (error) {
    console.error('Error searching images:', error);
    return [];
  }
}

// Pre-cache images for a list of photo references
export async function preCacheImages(
  photoRefs: Array<{
    photoReference: string;
    facilityId?: string;
    googlePlaceId?: string;
    width?: number;
  }>
): Promise<Array<{ photoReference: string; url: string | null; success: boolean }>> {
  const results = [];
  
  for (const ref of photoRefs) {
    try {
      const url = await getCachedPhotoUrl(
        ref.photoReference,
        ref.width || 600,
        ref.facilityId,
        ref.googlePlaceId
      );
      
      results.push({
        photoReference: ref.photoReference,
        url,
        success: !!url
      });
    } catch (error) {
      console.error(`Failed to pre-cache image ${ref.photoReference}:`, error);
      results.push({
        photoReference: ref.photoReference,
        url: null,
        success: false
      });
    }
  }
  
  console.log(`🎯 Pre-cache completed: ${results.filter(r => r.success).length}/${results.length} successful`);
  return results;
}

// Get storage usage information
export async function getStorageInfo(): Promise<{
  totalFiles: number;
  totalSize: number;
  cacheDirSize: number;
  averageFileSize: number;
}> {
  try {
    // Get MongoDB stats
    const mongoStats = await ImageCache.aggregate([
      {
        $group: {
          _id: null,
          totalFiles: { $sum: 1 },
          totalSize: { $sum: "$fileSize" },
          averageFileSize: { $avg: "$fileSize" }
        }
      }
    ]);
    
    // Get file system stats
    let cacheDirSize = 0;
    try {
      const files = await fs.readdir(IMAGE_CACHE_DIR);
      for (const file of files) {
        if (file.startsWith('photo_') && file.endsWith('.jpg')) {
          const stats = await fs.stat(path.join(IMAGE_CACHE_DIR, file));
          cacheDirSize += stats.size;
        }
      }
    } catch (error) {
      console.error('Error calculating cache directory size:', error);
    }
    
    const stats = mongoStats[0] || { totalFiles: 0, totalSize: 0, averageFileSize: 0 };
    
    return {
      totalFiles: stats.totalFiles,
      totalSize: stats.totalSize,
      cacheDirSize,
      averageFileSize: Math.round(stats.averageFileSize)
    };
  } catch (error) {
    console.error('Error getting storage info:', error);
    return {
      totalFiles: 0,
      totalSize: 0,
      cacheDirSize: 0,
      averageFileSize: 0
    };
  }
}