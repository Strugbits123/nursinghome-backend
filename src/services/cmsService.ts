import axios from "axios";
import Facility, { IFacility } from "../models/facilityModel";

const CMS_API_URL =
  "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0";


export const syncFacilities = async (): Promise<{ success: boolean; count: number }> => {
  try {
    const { data } = await axios.post(CMS_API_URL, 
      {
        conditions: [
          {
            resource: "t",
            property: "record_number",
            value: "TX",
            operator: ">", // fetch all rows after record 1
          },
        ],
        limit: 50, // adjust as needed
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
        { cmsId: f.cms_certification_number_ccn }, // unique CMS ID
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
