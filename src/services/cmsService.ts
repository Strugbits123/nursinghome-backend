import axios from "axios";
import Facility, { IFacility } from "../models/facilityModel";


import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import NursingFacility, { INursingFacility } from '../models/NursingFacility';

const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";


export const syncFacilities2 = async (): Promise<{ success: boolean; count: number }> => {
  try {
    const { data } = await axios.post(CMS_API_URL, 
      {
        conditions: [
          {
            resource: "t",
            property: "record_number",
            value: "TX",
            operator: ">",
          },
        ],
        limit: 50,
      },
      {
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
      }
    );

    const facilities: any[] = data?.results || [];
    console.log(`Fetched ${facilities.length} facilities from CMS`);

    for (const f of facilities) {
      console.log("Mapping row:", f);

      await Facility.findOneAndUpdate(
        { cmsId: f.cms_certification_number_ccn },
        {
          cmsId: f.cms_certification_number_ccn,
          name: f.provider_name,
          address: f.provider_address,
          city: f.citytown,
          state: f.state,
          zip: f.zip_code,
          phone: f.telephone_number,
          ownership: f.ownership_type,
          bedCount: f.number_of_certified_beds,
          rating: f.overall_rating,
          lastUpdated: new Date(),
        },
        { upsert: true, new: true }
      );
    }

    return { success: true, count: facilities.length };
  } catch (err: any) {
    console.error("CMS sync error:", err.response?.data || err.message);
    throw err;
  }
};

// Adjust this path if your file location is different!
const csvFilePath = path.join(__dirname, '..', 'data', 'NH_ProviderInfo_Sep2025.csv');

/**
 * Type guard function to safely convert a value to a number or null.
 * @param value The input string or number.
 * @returns A number or null.
 */
const safeParseNumber = (value: any): number | null => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Helper to safely convert a value to a string or null.
 * @param val The input value.
 * @returns A string or null.
 */
const strOrNull = (val: any): string | null => {
  if (val === undefined || val === null || String(val).trim() === '') {
    return null;
  }
  return String(val);
};

/**
 * Maps the verbose CSV headers to the clean Mongoose schema field names.
 * This function handles all 100 fields.
 * @param record A single parsed CSV record object.
 * @returns An object conforming to the INursingFacility interface structure.
 */
const mapCsvRecordToFacility = (record: any): Partial<INursingFacility> => {
  const facility: Partial<INursingFacility> = {
    // Basic Information
    cms_certification_number_ccn: strOrNull(record['CMS Certification Number (CCN)']) || '',
    provider_name: strOrNull(record['Provider Name']),
    provider_address: strOrNull(record['Provider Address']),
    city_town: strOrNull(record['City/Town']),
    state: strOrNull(record['State']),
    zip_code: strOrNull(record['ZIP Code']),
    telephone_number: strOrNull(record['Telephone Number']),
    provider_ssa_county_code: strOrNull(record['Provider SSA County Code']),
    county_parish: strOrNull(record['County/Parish']),
    ownership_type: strOrNull(record['Ownership Type']),
    number_of_certified_beds: safeParseNumber(record['Number of Certified Beds']),
    average_number_of_residents_per_day: safeParseNumber(record['Average Number of Residents per Day']),
    average_number_of_residents_per_day_footnote: strOrNull(record['Average Number of Residents per Day Footnote']),
    provider_type: strOrNull(record['Provider Type']),
    provider_resides_in_hospital: strOrNull(record['Provider Resides in Hospital']),
    legal_business_name: strOrNull(record['Legal Business Name']),
    date_first_approved_to_provide_medicare_and_medicaid_services: record['Date First Approved to Provide Medicare and Medicaid Services'] ? new Date(record['Date First Approved to Provide Medicare and Medicaid Services']) : null,
    
    // Chain Information
    chain_name: strOrNull(record['Chain Name']),
    chain_id: strOrNull(record['Chain ID']),
    number_of_facilities_in_chain: safeParseNumber(record['Number of Facilities in Chain']),
    chain_average_overall_5_star_rating: strOrNull(record['Chain Average Overall 5-star Rating']),
    chain_average_health_inspection_rating: strOrNull(record['Chain Average Health Inspection Rating']),
    chain_average_staffing_rating: strOrNull(record['Chain Average Staffing Rating']),
    chain_average_qm_rating: strOrNull(record['Chain Average QM Rating']),
    
    // Status Flags
    continuing_care_retirement_community: strOrNull(record['Continuing Care Retirement Community']),
    special_focus_status: strOrNull(record['Special Focus Status']),
    abuse_icon: strOrNull(record['Abuse Icon']),
    most_recent_health_inspection_more_than_2_years_ago: strOrNull(record['Most Recent Health Inspection More Than 2 Years Ago']),
    provider_changed_ownership_in_last_12_months: strOrNull(record['Provider Changed Ownership in Last 12 Months']),
    with_a_resident_and_family_council: strOrNull(record['With a Resident and Family Council']),
    automatic_sprinkler_systems_in_all_required_areas: strOrNull(record['Automatic Sprinkler Systems in All Required Areas']),
    
    // Rating Information
    overall_rating: strOrNull(record['Overall Rating']),
    overall_rating_footnote: strOrNull(record['Overall Rating Footnote']),
    health_inspection_rating: strOrNull(record['Health Inspection Rating']),
    health_inspection_rating_footnote: strOrNull(record['Health Inspection Rating Footnote']),
    qm_rating: strOrNull(record['QM Rating']),
    qm_rating_footnote: strOrNull(record['QM Rating Footnote']),
    long_stay_qm_rating: strOrNull(record['Long-Stay QM Rating']),
    long_stay_qm_rating_footnote: strOrNull(record['Long-Stay QM Rating Footnote']),
    short_stay_qm_rating: strOrNull(record['Short-Stay QM Rating']),
    short_stay_qm_rating_footnote: strOrNull(record['Short-Stay QM Rating Footnote']),
    staffing_rating: strOrNull(record['Staffing Rating']),
    staffing_rating_footnote: strOrNull(record['Staffing Rating Footnote']),
    reported_staffing_footnote: strOrNull(record['Reported Staffing Footnote']),
    physical_therapist_staffing_footnote: strOrNull(record['Physical Therapist Staffing Footnote']),
    
    // Staffing Hours (Reported)
    reported_nurse_aide_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported Nurse Aide Staffing Hours per Resident per Day']),
    reported_lpn_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported LPN Staffing Hours per Resident per Day']),
    reported_rn_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported RN Staffing Hours per Resident per Day']),
    reported_licensed_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported Licensed Staffing Hours per Resident per Day']),
    reported_total_nurse_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported Total Nurse Staffing Hours per Resident per Day']),
    total_number_of_nurse_staff_hours_per_resident_per_day_on_the_weekend: safeParseNumber(record['Total number of nurse staff hours per resident per day on the weekend']),
    registered_nurse_hours_per_resident_per_day_on_the_weekend: safeParseNumber(record['Registered Nurse hours per resident per day on the weekend']),
    reported_physical_therapist_staffing_hours_per_resident_per_day: safeParseNumber(record['Reported Physical Therapist Staffing Hours per Resident Per Day']),
    
    // Turnover and Case-Mix
    total_nursing_staff_turnover: strOrNull(record['Total nursing staff turnover']),
    total_nursing_staff_turnover_footnote: strOrNull(record['Total nursing staff turnover footnote']),
    registered_nurse_turnover: strOrNull(record['Registered Nurse turnover']),
    registered_nurse_turnover_footnote: strOrNull(record['Registered Nurse turnover footnote']),
    number_of_administrators_who_have_left_the_nursing_home: safeParseNumber(record['Number of administrators who have left the nursing home']),
    administrator_turnover_footnote: strOrNull(record['Administrator turnover footnote']),
    nursing_case_mix_index: safeParseNumber(record['Nursing Case-Mix Index']),
    nursing_case_mix_index_ratio: safeParseNumber(record['Nursing Case-Mix Index Ratio']),
    
    // Case-Mix Adjusted Staffing
    case_mix_nurse_aide_staffing_hours_per_resident_per_day: safeParseNumber(record['Case-Mix Nurse Aide Staffing Hours per Resident per Day']),
    case_mix_lpn_staffing_hours_per_resident_per_day: safeParseNumber(record['Case-Mix LPN Staffing Hours per Resident per Day']),
    case_mix_rn_staffing_hours_per_resident_per_day: safeParseNumber(record['Case-Mix RN Staffing Hours per Resident per Day']),
    case_mix_total_nurse_staffing_hours_per_resident_per_day: safeParseNumber(record['Case-Mix Total Nurse Staffing Hours per Resident per Day']),
    case_mix_weekend_total_nurse_staffing_hours_per_resident_per_day: safeParseNumber(record['Case-Mix Weekend Total Nurse Staffing Hours per Resident per Day']),
    
    // Adjusted Staffing (Further Adjusted)
    adjusted_nurse_aide_staffing_hours_per_resident_per_day: safeParseNumber(record['Adjusted Nurse Aide Staffing Hours per Resident per Day']),
    adjusted_lpn_staffing_hours_per_resident_per_day: safeParseNumber(record['Adjusted LPN Staffing Hours per Resident per Day']),
    adjusted_rn_staffing_hours_per_resident_per_day: safeParseNumber(record['Adjusted RN Staffing Hours per Resident per Day']),
    adjusted_total_nurse_staffing_hours_per_resident_per_day: safeParseNumber(record['Adjusted Total Nurse Staffing Hours per Resident per Day']),
    adjusted_weekend_total_nurse_staffing_hours_per_resident_per_day: safeParseNumber(record['Adjusted Weekend Total Nurse Staffing Hours per Resident per Day']),
    
    // Rating Cycle 1 Health Survey
    rating_cycle_1_standard_survey_health_date: strOrNull(record['Rating Cycle 1 Standard Survey Health Date']),
    rating_cycle_1_total_number_of_health_deficiencies: safeParseNumber(record['Rating Cycle 1 Total Number of Health Deficiencies']),
    rating_cycle_1_number_of_standard_health_deficiencies: safeParseNumber(record['Rating Cycle 1 Number of Standard Health Deficiencies']),
    rating_cycle_1_number_of_complaint_health_deficiencies: safeParseNumber(record['Rating Cycle 1 Number of Complaint Health Deficiencies']),
    rating_cycle_1_health_deficiency_score: safeParseNumber(record['Rating Cycle 1 Health Deficiency Score']),
    rating_cycle_1_number_of_health_revisits: safeParseNumber(record['Rating Cycle 1 Number of Health Revisits']),
    rating_cycle_1_health_revisit_score: safeParseNumber(record['Rating Cycle 1 Health Revisit Score']),
    rating_cycle_1_total_health_score: safeParseNumber(record['Rating Cycle 1 Total Health Score']),
    
    // Rating Cycle 2/3 Health Survey
    rating_cycle_2_standard_health_survey_date: strOrNull(record['Rating Cycle 2 Standard Health Survey Date']),
    rating_cycle_2_3_total_number_of_health_deficiencies: safeParseNumber(record['Rating Cycle 2/3 Total Number of Health Deficiencies']),
    rating_cycle_2_number_of_standard_health_deficiencies: safeParseNumber(record['Rating Cycle 2 Number of Standard Health Deficiencies']),
    rating_cycle_2_3_number_of_complaint_health_deficiencies: safeParseNumber(record['Rating Cycle 2/3 Number of Complaint Health Deficiencies']),
    rating_cycle_2_3_health_deficiency_score: safeParseNumber(record['Rating Cycle 2/3 Health Deficiency Score']),
    rating_cycle_2_3_number_of_health_revisits: safeParseNumber(record['Rating Cycle 2/3 Number of Health Revisits']),
    rating_cycle_2_3_health_revisit_score: safeParseNumber(record['Rating Cycle 2/3 Health Revisit Score']),
    rating_cycle_2_3_total_health_score: safeParseNumber(record['Rating Cycle 2/3 Total Health Score']),
    
    // Penalties and Incidents
    total_weighted_health_survey_score: safeParseNumber(record['Total Weighted Health Survey Score']),
    number_of_facility_reported_incidents: safeParseNumber(record['Number of Facility Reported Incidents']),
    number_of_substantiated_complaints: safeParseNumber(record['Number of Substantiated Complaints']),
    number_of_citations_from_infection_control_inspections: safeParseNumber(record['Number of Citations from Infection Control Inspections']),
    number_of_fines: safeParseNumber(record['Number of Fines']),
    total_amount_of_fines_in_dollars: safeParseNumber(record['Total Amount of Fines in Dollars']),
    number_of_payment_denials: safeParseNumber(record['Number of Payment Denials']),
    total_number_of_penalties: safeParseNumber(record['Total Number of Penalties']),
    
    // Geolocation and Processing
    location: strOrNull(record['Location']),
    latitude: safeParseNumber(record['Latitude']),
    longitude: safeParseNumber(record['Longitude']),
    geocoding_footnote: strOrNull(record['Geocoding Footnote']),
    processing_date: record['Processing Date'] ? new Date(record['Processing Date']) : null,
  };
  
  return facility;
};


/**
 * Reads the CSV, parses the data, and syncs it with the MongoDB collection using bulk operations.
 */
export const syncFacilities = async (): Promise<void> => {
  console.log('Starting CMS facility data synchronization...');

  if (!fs.existsSync(csvFilePath)) {
    console.error(`Error: CSV file not found at ${csvFilePath}`);
    return;
  }

  const parser = fs
    .createReadStream(csvFilePath)
    .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }));

  let recordsProcessed = 0;
  let recordsUpserted = 0;
  
  const bulkOperations = [];

  for await (const record of parser) {
    recordsProcessed++;
    const facilityData = mapCsvRecordToFacility(record);
    const ccn = facilityData.cms_certification_number_ccn;
    
    if (!ccn) {
        console.warn('Skipping record with missing CMS Certification Number (CCN).');
        continue;
    }

    bulkOperations.push({
        updateOne: {
            filter: { cms_certification_number_ccn: ccn },
            update: { $set: facilityData },
            upsert: true,
        }
    });

    if (bulkOperations.length >= 1000) {
        const result = await NursingFacility.bulkWrite(bulkOperations);
        recordsUpserted += result.upsertedCount + result.modifiedCount; 
        bulkOperations.length = 0;
    }
  }

  if (bulkOperations.length > 0) {
    const result = await NursingFacility.bulkWrite(bulkOperations);
    recordsUpserted += result.upsertedCount + result.modifiedCount;
  }

  console.log('CMS facility data synchronization complete.');
  console.log(`Total records processed: ${recordsProcessed}`);
  console.log(`Total records upserted (new or updated): ${recordsUpserted}`);
};