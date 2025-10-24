# Google API Cost Optimization Guide

## 🚨 Problem Analysis

Your Google API costs were high because you have **600-700 facilities** and each facility was making **4 API calls**:
1. `findPlaceIdByText(facility.provider_name)` 
2. `findPlaceIdByText(facility.provider_name + zip_code)`
3. `findPlaceIdByText(facility.provider_name + city_town)`
4. `getPlaceDetails(placeId)`

**Total API calls per facility: 4**
**Total API calls for 700 facilities: 2,800 calls**
**Estimated cost: $47.60 per full refresh** (at $0.017 per Text Search + Place Details call)

## ✅ Optimizations Implemented

### 1. **Redis Caching System**
- **Place ID caching**: 30 days TTL
- **Place Details caching**: 30 days TTL  
- **Coordinates caching**: 1 year TTL (coordinates rarely change)
- **Cache hit rate**: Expected 80-90% after initial population

### 2. **Rate Limiting & Batch Processing**
- **Batch size**: 5 facilities per batch
- **Rate limit**: 1 second delay between batches
- **Queue system**: Prevents API overload
- **Parallel processing**: Within batches for efficiency

### 3. **Smart Search Strategy**
- **Early exit**: Stop searching once place ID is found
- **Normalized queries**: Consistent cache keys
- **Fallback strategies**: Multiple search approaches per facility

### 4. **API Usage Monitoring**
- **Real-time tracking**: Cache hits vs misses
- **Cost estimation**: Based on Google's pricing
- **Usage analytics**: Request types and patterns

## 📊 Expected Cost Savings

### Before Optimization:
- **700 facilities × 4 API calls = 2,800 calls**
- **Cost: ~$47.60 per full refresh**

### After Optimization:
- **First run**: 2,800 calls (populate cache)
- **Subsequent runs**: ~280 calls (10% cache miss rate)
- **Cost: ~$4.76 per refresh (90% reduction)**

### Monthly Savings (assuming daily refresh):
- **Before**: $47.60 × 30 = $1,428/month
- **After**: $4.76 × 30 = $142.80/month
- **Savings**: $1,285.20/month (90% reduction)

## 🚀 New API Endpoints

### 1. Batch Processing
```bash
POST /api/facilities/batch-google-data
{
  "facilityIds": ["id1", "id2", "id3"],
  "limit": 50
}
```

### 2. API Usage Stats
```bash
GET /api/place/stats
```

### 3. Reset Usage Stats
```bash
POST /api/place/reset-stats
```

## 🔧 Implementation Details

### Cache Keys Structure:
```
google:place_id:{normalized_query}
google:place_details:{place_id}
google:coordinates:{normalized_address}
```

### Rate Limiting Logic:
```typescript
// Process 5 facilities per batch
// Wait 1 second between batches
// Track API usage and cache hits
```

### Error Handling:
- **Graceful degradation**: Continue processing if some facilities fail
- **Retry logic**: Built-in axios retry with exponential backoff
- **Fallback responses**: Return cached data when possible

## 📈 Monitoring & Maintenance

### Key Metrics to Watch:
1. **Cache hit rate**: Should be >80%
2. **API request count**: Should decrease over time
3. **Error rate**: Should be <5%
4. **Processing time**: Should improve with caching

### Regular Maintenance:
1. **Monitor cache hit rates** weekly
2. **Review API usage stats** monthly
3. **Adjust cache TTL** based on data freshness needs
4. **Update batch sizes** based on performance

## 🎯 Usage Recommendations

### For Initial Setup:
1. **Run batch processing** for all 700 facilities once
2. **Monitor cache population** and API usage
3. **Verify data quality** and completeness

### For Ongoing Operations:
1. **Use batch processing** for new facilities
2. **Monitor cache hit rates** regularly
3. **Refresh stale data** periodically (monthly)
4. **Track cost savings** using the stats endpoint

### For Emergency Situations:
1. **Disable caching** temporarily if needed
2. **Reset usage stats** to start fresh monitoring
3. **Adjust rate limits** based on Google's quotas

## 🔍 Troubleshooting

### High API Usage:
- Check cache hit rates
- Verify Redis connection
- Review batch processing logs

### Slow Performance:
- Increase batch size (if within rate limits)
- Check Redis performance
- Monitor database query times

### Data Quality Issues:
- Review search query strategies
- Check facility name normalization
- Verify place ID accuracy

## 📞 Support

If you encounter issues:
1. Check the API usage stats endpoint
2. Review server logs for errors
3. Monitor Redis cache performance
4. Verify Google API key limits

---

**Remember**: The key to cost optimization is **aggressive caching** and **smart batch processing**. With these optimizations, your Google API costs should drop by 80-90% while maintaining the same functionality.
